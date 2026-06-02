import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { Request } from 'express';
import { JWTPayload } from 'jose';
import { loadEnv } from '../config/env';

/**
 * Rate limiting for the Claude-powered endpoints (Sprint N).
 *
 * `/api/insights` and `/api/marketing` each call the Anthropic API, so an
 * abusive or buggy client could run up real cost. This limiter caps how often a
 * single authenticated user can hit those endpoints.
 *
 * Configuration (see .env.example):
 *   RATE_LIMIT_WINDOW_MINUTES  rolling window length in minutes (default 15)
 *   RATE_LIMIT_MAX_REQUESTS    requests allowed per user per window (default 50)
 *
 * Keying: the limiter is mounted *after* authMiddleware on the AI routers, so
 * `req.user.sub` (the Supabase user id) is available and we rate-limit per user
 * rather than per IP — fairer behind shared NATs/proxies. If for some reason the
 * user id is missing, we fall back to the client IP (via `ipKeyGenerator`, which
 * normalizes IPv6 correctly as required by express-rate-limit v8).
 */

interface AuthRequest extends Request {
  user?: JWTPayload;
}

export function createAiRateLimiter() {
  const env = loadEnv();
  const windowMs = env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;
  const limit = env.RATE_LIMIT_MAX_REQUESTS;

  return rateLimit({
    windowMs,
    limit,
    // Return rate-limit info in the standardized `RateLimit-*` headers and drop
    // the legacy `X-RateLimit-*` ones.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: AuthRequest): string => {
      const userId = req.user?.sub;
      if (typeof userId === 'string' && userId.length > 0) return userId;
      // Fallback for unauthenticated/edge cases — normalize IP for IPv6.
      return ipKeyGenerator(req.ip ?? '');
    },
    // Consistent error envelope rather than express-rate-limit's default text.
    handler: (_req, res) => {
      res.status(429).json({
        data: null,
        error: 'Rate limit exceeded — please slow down and try again shortly.',
      });
    },
  });
}
