// Validate environment first. Importing this module fails the process fast
// (with a readable message) if required variables are missing — before any
// other module reads process.env.
import { loadEnv } from './config/env';
import { corsOptions } from './config/cors';
// Patches Express so errors thrown in async route handlers are forwarded to the
// centralized error middleware instead of becoming unhandled rejections. Must be
// imported before the routers are defined/mounted.
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { startScheduler, stopScheduler } from './services/scheduler';

const env = loadEnv();

const app = express();
const port = env.PORT;

// --- Security & observability middleware (Sprint N) ------------------------
// helmet sets standard security headers. This backend serves only JSON to a
// separate-origin SPA (Vercel) and to Supabase/Anthropic over server-to-server
// HTTPS, so we relax cross-origin resource policy to 'cross-origin' (the SPA
// fetches via CORS) and keep helmet's other secure defaults. CSP on a pure JSON
// API does not affect the frontend's own CSP, so it is left at the safe default.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(cors(corsOptions()));
// Structured request logging (method, route, status, response time). Mounted
// early so it observes every request; skips /health internally.
app.use(requestLogger());
app.use(express.json());

// Health check — no auth, no envelope, mounted at top level for Railway plus an
// /api alias. Registered before the API routers so it never hits auth/limits.
app.use('/health', healthRouter);
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

// 404 for any unmatched route, then the centralized error handler. Both must be
// registered LAST — Express only routes to the error handler (4-arg) for errors
// raised by the middleware/routes declared above it.
app.use(notFoundHandler);
app.use(errorHandler);

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
