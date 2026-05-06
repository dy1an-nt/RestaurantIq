import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import jwt from 'jsonwebtoken';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

/**
 * Supabase exposes JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
 * Newer projects sign with ES256 (asymmetric) and require the JWKS for
 * verification. Older projects use a shared HS256 secret. We support both:
 *   1. Try JWKS verification (ES256/RS256 etc.)
 *   2. Fall back to the legacy HS256 shared secret if SUPABASE_JWT_SECRET is set
 */

// Lazy: resolve JWKS on first request so dotenv.config() (in server.ts) has
// already populated process.env by the time we read SUPABASE_URL.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJwks = () => {
  if (cachedJwks) return cachedJwks;
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  cachedJwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return cachedJwks;
};

const verifyAsymmetric = async (token: string): Promise<JWTPayload | null> => {
  const jwks = getJwks();
  if (!jwks) {
    console.error('[auth] JWKS not configured — SUPABASE_URL missing?');
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks);
    return payload;
  } catch (err: any) {
    console.error('[auth] JWKS verify failed:', err?.code, err?.message);
    return null;
  }
};

const verifyHs256 = (token: string): JWTPayload | null => {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  try {
    return jwt.verify(token, secret) as JWTPayload;
  } catch (err: any) {
    console.error('[auth] HS256 verify failed:', err?.message);
    return null;
  }
};

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ data: null, error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);

  const payload = (await verifyAsymmetric(token)) ?? verifyHs256(token);

  if (!payload) {
    return res.status(401).json({ data: null, error: 'Invalid token' });
  }

  req.user = payload;
  next();
};
