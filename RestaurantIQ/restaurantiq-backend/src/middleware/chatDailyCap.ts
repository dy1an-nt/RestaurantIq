import { Request, Response, NextFunction } from 'express';
import { supabase } from '../db';

const DEFAULT_DAILY_CAP = 50;

export interface ChatUsage {
  messagesToday: number;
  dailyCap: number;
  /** ISO timestamp of the next UTC midnight, when the count resets. */
  resetsAt: string;
}

// A malformed CHAT_DAILY_MESSAGE_CAP must fall back to the default, not
// disable the cap: parseInt of garbage is NaN, and `count >= NaN` is always
// false — which would silently turn the cost control off.
function dailyCap(): number {
  const parsed = parseInt(process.env.CHAT_DAILY_MESSAGE_CAP ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

/**
 * Single source of truth for chat usage vs. the daily cap. GET /api/chat/usage
 * displays these numbers and the chatDailyCap middleware enforces them —
 * computing both from one function keeps the displayed and enforced values
 * from drifting.
 */
export async function getChatUsage(restaurantId: string): Promise<ChatUsage> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const nextMidnight = new Date(midnight);
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);

  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('role', 'user')
    .gte('created_at', midnight.toISOString());

  return {
    messagesToday: count ?? 0,
    dailyCap: dailyCap(),
    resetsAt: nextMidnight.toISOString(),
  };
}

/**
 * Per-day chat message cap. Mounted after requireRestaurant, so the tenant is
 * already resolved on req.restaurantId — this middleware no longer repeats the
 * user→restaurant lookup, it just counts today's messages against the cap.
 *
 * Count-then-insert is not atomic, so concurrent requests can overshoot the
 * cap by a few messages — acceptable for a soft cost control.
 */
export async function chatDailyCap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const restaurantId = req.restaurantId;
  if (!restaurantId) {
    res.status(404).json({ data: null, error: 'Restaurant not found' });
    return;
  }

  const usage = await getChatUsage(restaurantId);

  if (usage.messagesToday >= usage.dailyCap) {
    res.status(429).json({
      data: null,
      error: 'Daily chat limit reached — resets at midnight UTC',
    });
    return;
  }

  next();
}
