import { Router, Request, Response } from 'express';
import { supabase } from '../db';

const router = Router();

router.get('/:restaurantId/menu-items', async (req: Request, res: Response) => {
  const { restaurantId } = req.params;

  const { data, error } = await supabase
    .from('menu_items')
    .select('id, name, category, price_cents, cost_cents, source')
    .eq('restaurant_id', restaurantId);

  if (error) {
    console.error(error);
    return res.status(500).json({ data: null, error: 'Failed to fetch menu items' });
  }

  return res.json({ data, error: null });
});

export default router;
