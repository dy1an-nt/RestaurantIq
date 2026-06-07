import { Request, Response, NextFunction } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

export async function chatDailyCap(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.user?.sub;
  if (!userId) {
    res.status(401).json({ data: null, error: 'Unauthorized' });
    return;
  }

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!restaurant) {
    res.status(404).json({ data: null, error: 'Restaurant not found' });
    return;
  }

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.id)
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
