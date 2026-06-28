import express from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import {
  createRestaurant,
  getRestaurant,
  updateRestaurant,
  getMyRestaurant,
} from '../controllers/restaurantController';

const router = express.Router();

// All restaurant routes require authentication
router.use(authMiddleware);

// Creating a restaurant: `name` is the only hard requirement (review H2 flagged
// that the controller trusted it unconditionally). Connection flags/ids are
// optional and default in the controller.
const createRestaurantSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200, 'name must be 200 characters or fewer'),
  location: z.string().max(300).optional(),
  pos_connected: z.boolean().optional(),
  delivery_connected: z.boolean().optional(),
  square_location_id: z.string().nullable().optional(),
  doordash_store_id: z.string().nullable().optional(),
});

// Updating: every field is optional (the controller applies only what is
// present), but anything present must be the right shape.
const updateRestaurantSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty').max(200, 'name must be 200 characters or fewer').optional(),
  location: z.string().max(300).optional(),
  doordash_store_id: z.string().nullable().optional(),
});

router.post('/', validateBody(createRestaurantSchema), createRestaurant);
router.get('/me', getMyRestaurant);   // must be defined before /:id
router.get('/:id', getRestaurant);
router.put('/:id', validateBody(updateRestaurantSchema), updateRestaurant);

export default router;