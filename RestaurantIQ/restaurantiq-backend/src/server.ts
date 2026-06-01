import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import healthRouter from './routes/health';
import restaurantRoutes from './routes/restaurant';
import menuItemsRouter from './routes/menuItems';
import insightsRouter from './routes/insights';
import squareIntegrationRouter from './routes/integrations/square';
import doordashIntegrationRouter from './routes/integrations/doordash';
import syncStatusRouter from './routes/integrations/syncStatus';
import alertsRouter from './routes/alerts';
import analyticsRouter from './routes/analytics';
import marketingRouter from './routes/marketing';
import { startScheduler, stopScheduler } from './services/scheduler';

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
app.use('/api/integrations/doordash', doordashIntegrationRouter);
app.use('/api/integrations', syncStatusRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/marketing', marketingRouter);

app.listen(port, () => {
  console.error(`RestaurantIQ API running on port ${port}`);
  // Start the distributed sync scheduler once the HTTP listener is up.
  // The scheduler attempts leader election (Postgres advisory lock via pg.Client)
  // and only dispatches syncs when this instance holds the lock (Sprint L+).
  startScheduler();
});

// Graceful shutdown: release the advisory lock so a standby instance can take
// over immediately instead of waiting for the stale-lock window.
const shutdown = async (signal: string): Promise<void> => {
  console.error(
    JSON.stringify({ event: 'SHUTDOWN', ts: new Date().toISOString(), signal }),
  );
  await stopScheduler();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
