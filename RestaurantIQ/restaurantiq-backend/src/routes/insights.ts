import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../server';
import { generateInsights } from '../services/anthropicService';

const router = Router();

router.use(authMiddleware);

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user?: { sub?: string } }).user?.sub;
    if (!userId) {
      return res.status(401).json({ data: null, error: 'Missing user id on token' });
    }

    const { data: restaurant, error: restaurantErr } = await supabase
      .from('restaurants')
      .select('id, name')
      .eq('user_id', userId)
      .maybeSingle();

    if (restaurantErr) throw restaurantErr;
    if (!restaurant) {
      return res.status(404).json({ data: null, error: 'No restaurant found for this user' });
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

    const { data: rawSummaries, error: summariesErr } = await supabase
      .from('daily_summaries')
      .select('date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)')
      .eq('restaurant_id', restaurant.id)
      .gte('date', thirtyDaysAgoStr)
      .order('date', { ascending: false });

    if (summariesErr) throw summariesErr;

    const summaries = (rawSummaries ?? []).map((row: any) => ({
      date: row.date as string,
      total_quantity: row.total_quantity as number,
      total_revenue_cents: row.total_revenue_cents as number,
      total_orders: row.total_orders as number,
      menu_item_name: (row.menu_items?.name ?? '') as string,
      menu_item_category: (row.menu_items?.category ?? '') as string,
    }));

    const result = await generateInsights({
      restaurantName: restaurant.name,
      summaries,
    });

    return res.json({ data: result, error: null });
  } catch (error: any) {
    console.error('[insights] Error generating insights:', error?.message);
    return res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
