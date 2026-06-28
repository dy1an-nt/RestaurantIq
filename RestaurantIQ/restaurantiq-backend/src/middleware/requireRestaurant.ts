import { Request, Response, NextFunction } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';

/**
 * Tenant-resolution middleware (Sprint R, review H1).
 *
 * Before this existed, the block "look up the restaurants row WHERE user_id =
 * <jwt sub>, 404 if absent" was copy-pasted across ~20 call sites (4× in
 * analytics.ts alone). That block IS the multi-tenant isolation boundary: every
 * duplicate is a place to forget the `user_id` scope or get it subtly wrong, and
 * correctness there is the only thing standing between tenants. Collapsing it
 * into one audited middleware means there is exactly one implementation to get
 * right and one place to review.
 *
 * Usage: mount AFTER authMiddleware (which sets req.user). On success it sets
 *   - req.restaurantId — the resolved id, the value almost every handler needs
 *   - req.restaurant   — the selected row, for handlers that need more columns
 * and calls next(). On failure it sends the standard 401/404 envelope and stops.
 *
 * `columns` lets a router request extra columns in the same single query it
 * already pays for (e.g. analytics needs the DoorDash economics fields), so no
 * route has to re-fetch the restaurant it just resolved.
 */
export interface ResolvedRestaurant {
  id: string;
  [key: string]: unknown;
}

interface AuthedRequest extends Request {
  user?: JWTPayload;
}

export function requireRestaurant(columns: string = 'id') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as AuthedRequest).user?.sub;
    if (!userId) {
      res.status(401).json({ data: null, error: 'Unauthorized' });
      return;
    }

    const { data, error } = await supabase
      .from('restaurants')
      .select(columns)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[requireRestaurant] lookup failed:', error.message);
      res.status(500).json({ data: null, error: 'Failed to resolve restaurant' });
      return;
    }
    if (!data) {
      res.status(404).json({ data: null, error: 'Restaurant not found' });
      return;
    }

    const restaurant = data as unknown as ResolvedRestaurant;
    req.restaurant = restaurant;
    req.restaurantId = restaurant.id;
    next();
  };
}
