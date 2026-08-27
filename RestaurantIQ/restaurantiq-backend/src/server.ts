// Validate environment first. Importing this module fails the process fast
// (with a readable message) if required variables are missing - before any
// other module reads process.env.
import { loadEnv } from './config/env';
import { corsOptions } from './config/cors';
import { initSentry, flushSentry, captureBackgroundError } from './config/sentry';
// Patches Express so errors thrown in async route handlers are forwarded to the
// centralized error middleware instead of becoming unhandled rejections. Must be
// imported before the routers are defined/mounted.
import 'express-async-errors';
import * as Sentry from '@sentry/node';
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
import chatRouter from './routes/chat';
import advisorRouter from './routes/advisor';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { startScheduler, stopScheduler } from './services/scheduler';

const env = loadEnv();

// Error tracking. Must come after loadEnv() so dotenv has populated SENTRY_DSN
// (docs/sharp-edges.md: env vars are read lazily). No DSN -> completely inert.
const sentryEnabled = initSentry();

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

// Health check - no auth, no envelope, mounted at top level for Railway plus an
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
app.use('/api/chat', chatRouter);
app.use('/api/advisor', advisorRouter);

// 404 for any unmatched route, then the centralized error handler. Both must be
// registered LAST - Express only routes to the error handler (4-arg) for errors
// raised by the middleware/routes declared above it.
app.use(notFoundHandler);

// Sentry's error handler must sit AFTER the routes and BEFORE our own, so it
// observes the error and passes it along for the project's `{ data, error }`
// envelope to be rendered. 4xx are deliberately not reported: a client sending
// a bad request is not an incident, and reporting them buries real failures.
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError: (error) => {
      const status = (error as { status?: number; statusCode?: number }).status
        ?? (error as { statusCode?: number }).statusCode
        ?? 500;
      return status >= 500;
    },
  });
}

app.use(errorHandler);

app.listen(port, () => {
  console.error(`RestaurantIQ API running on port ${port}`);
  console.error(
    JSON.stringify({
      event: 'SENTRY_STATUS',
      ts: new Date().toISOString(),
      enabled: sentryEnabled,
    }),
  );
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
  // Flush buffered events before exiting, or the error that caused the crash
  // is discarded with the process.
  await flushSentry();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * Last-resort reporting for errors raised outside a request.
 *
 * The scheduler dispatches ticks as `void runSchedulerTick()`, so a rejection
 * there surfaces as an unhandled rejection with nothing watching it. Node's
 * default for both of these signals is to terminate, and that behaviour is
 * preserved. We exit(1) after flushing so Railway restarts a process that is
 * in an unknown state, rather than leaving it half-alive. The only thing added
 * is that the error gets recorded before the process goes away.
 */
const fatal = (kind: string) => (err: unknown): void => {
  console.error(
    JSON.stringify({
      event: 'FATAL',
      ts: new Date().toISOString(),
      kind,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  captureBackgroundError(err, { kind });
  void flushSentry().finally(() => process.exit(1));
};

process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));
