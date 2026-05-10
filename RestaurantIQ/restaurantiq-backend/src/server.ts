import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import healthRouter from './routes/health';
import restaurantRoutes from './routes/restaurant';
import menuItemsRouter from './routes/menuItems';
import insightsRouter from './routes/insights';
import squareIntegrationRouter from './routes/integrations/square';
import alertsRouter from './routes/alerts';
import analyticsRouter from './routes/analytics';
import marketingRouter from './routes/marketing';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/restaurants', menuItemsRouter);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/insights', insightsRouter);
app.use('/api/integrations/square', squareIntegrationRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/marketing', marketingRouter);

app.listen(port, () => {
  console.error(`RestaurantIQ API running on port ${port}`);
});
