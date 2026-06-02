import { Router } from 'express';

/**
 * Health check endpoint (Sprint N).
 *
 * Returns a plain status object (NOT the `{ data, error }` envelope) suitable
 * for platform health checks (Railway) and uptime monitors:
 *
 *   { "status": "ok", "timestamp": "<ISO>", "version": "<app version>" }
 *
 * No authentication, no database call — a health check must stay cheap and must
 * not depend on downstream services, so it reports only that the process is up
 * and serving. Mounted at both `/health` (primary) and `/api/health` (alias).
 */

// Resolve the version once at module load. `npm start`/`npm run` set
// npm_package_version automatically; APP_VERSION can override it explicitly.
const VERSION =
  process.env.APP_VERSION || process.env.npm_package_version || 'unknown';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: VERSION,
  });
});

export default router;
