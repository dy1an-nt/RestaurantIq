import express from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  createRestaurant,
  getRestaurant,
  updateRestaurant,
  getMyRestaurant,
} from '../controllers/restaurantController';

const router = express.Router();

// All restaurant routes require authentication
router.use(authMiddleware);

router.post('/', createRestaurant);
router.get('/me', getMyRestaurant);   // must be defined before /:id
router.get('/:id', getRestaurant);
router.put('/:id', updateRestaurant);

export default router;