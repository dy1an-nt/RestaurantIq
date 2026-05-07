import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import healthRouter from './routes/health';
import restaurantRoutes from './routes/restaurant';
import menuItemsRouter from './routes/menuItems';
import insightsRouter from './routes/insights';
import squareIntegrationRouter from './routes/integrations/square';
import insightsRouter from './routes/insights';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

app.use(cors());
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/restaurants', menuItemsRouter);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/insights', insightsRouter);
app.use('/api/integrations/square', squareIntegrationRouter);
app.use('/api/insights', insightsRouter);

app.listen(port, () => {
  console.error(`RestaurantIQ API running on port ${port}`);
});