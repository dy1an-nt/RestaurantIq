import { Request, Response, NextFunction } from 'express';
import { supabase } from '../db';

/**
 * Per-day chat message cap. Mounted after requireRestaurant, so the tenant is
 * already resolved on req.restaurantId — this middleware no longer repeats the
 * user→restaurant lookup, it just counts today's messages against the cap.
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

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('role', 'user')
    .gte('created_at', midnight.toISOString());

  const daily_cap = parseInt(process.env.CHAT_DAILY_MESSAGE_CAP ?? '50', 10);

  if ((count ?? 0) >= daily_cap) {
    res.status(429).json({
      data: null,
      error: 'Daily chat limit reached — resets at midnight UTC',
    });
    return;
  }

  next();
}
