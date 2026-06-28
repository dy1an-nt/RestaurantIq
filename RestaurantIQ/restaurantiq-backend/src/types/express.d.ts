import { JWTPayload } from 'jose';
import { ResolvedRestaurant } from '../middleware/requireRestaurant';

/**
 * Global Express Request augmentation (Sprint R).
 *
 * `user` is set by authMiddleware; `restaurant`/`restaurantId` are set by
 * requireRestaurant. Declaring them here once lets handlers read `req.user`,
 * `req.restaurantId`, and `req.restaurant` directly — typed — instead of the
 * per-file `interface AuthRequest extends Request` casts that were duplicated
 * across the routes.
 */
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      restaurant?: ResolvedRestaurant;
      restaurantId?: string;
    }
  }
}

export {};
