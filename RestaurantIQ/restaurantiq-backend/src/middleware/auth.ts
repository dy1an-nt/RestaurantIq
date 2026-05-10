import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import jwt from 'jsonwebtoken';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

type AuthMode = 'jwks' | 'hs256' | 'unconfigured';

let _mode: AuthMode | null = null;

const getMode = (): AuthMode => {
  if (_mode) return _mode;
  if (process.env.SUPABASE_URL) {
    _mode = 'jwks';
  } else if (process.env.SUPABASE_JWT_SECRET) {
    _mode = 'hs256';
  } else {
    _mode = 'unconfigured';
  }
  return _mode;
};

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJwks = () => {
  if (_jwks) return _jwks;
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  _jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return _jwks;
};

const verifyJwks = async (token: string): Promise<JWTPayload | null> => {
  const jwks = getJwks();
  if (!jwks) return null;
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
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ data: null, error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  const mode = getMode();

  if (mode === 'unconfigured') {
    console.error('[auth] Neither SUPABASE_URL nor SUPABASE_JWT_SECRET is configured');
    return res.status(503).json({ data: null, error: 'Auth service misconfigured' });
  }

  const payload = mode === 'jwks'
    ? await verifyJwks(token)
    : verifyHs256(token);

  if (!payload) {
    return res.status(401).json({ data: null, error: 'Invalid token' });
  }

  (req as AuthRequest).user = payload;
  next();
};
