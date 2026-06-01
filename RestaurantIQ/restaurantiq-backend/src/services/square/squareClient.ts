import { Client, Environment } from 'square';

/**
 * Build a Square SDK client.
 *
 * Two modes:
 *  - Per-restaurant: pass `accessToken` (token stored on the restaurant row after /connect).
 *  - Global/dev: omit `accessToken` and we fall back to SQUARE_ACCESS_TOKEN env var.
 *
 * SQUARE_ENVIRONMENT controls sandbox vs production. Defaults to sandbox.
 */
export interface SquareClientOptions {
  accessToken?: string | null;
}

export const isMockMode = (): boolean =>
  process.env.USE_MOCK === 'true' || process.env.USE_MOCK === '1';

export const getSquareClient = ({ accessToken }: SquareClientOptions = {}): Client => {
  const token = accessToken ?? process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'No Square access token. Provide one via /api/integrations/square/connect or set SQUARE_ACCESS_TOKEN.',
    );
  }

  const envName = (process.env.SQUARE_ENVIRONMENT ?? 'sandbox').toLowerCase();
  const environment = envName === 'production' ? Environment.Production : Environment.Sandbox;

  console.error(
    `[square] using env=${environment} token=${token.slice(0, 12)}... len=${token.length}`,
  );

  return new Client({
    accessToken: token,
    environment,
    userAgentDetail: 'RestaurantIQ/1.0',
  });
};

/** Square OAuth API version pinned for the token endpoint. */
const SQUARE_VERSION = process.env.SQUARE_VERSION ?? '2024-06-04';

/** Resolve the Square OAuth base URL from the configured environment. */
const getOAuthBaseUrl = (): string => {
  if (process.env.SQUARE_OAUTH_BASE_URL) return process.env.SQUARE_OAUTH_BASE_URL;
  const envName = (process.env.SQUARE_ENVIRONMENT ?? 'sandbox').toLowerCase();
  return envName === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
};

export interface RefreshedSquareToken {
  accessToken: string;
  /** Square usually returns a refresh token on refresh; null when omitted. */
  refreshToken: string | null;
  /** ISO timestamp Square reports for the new access token's expiry; null if absent. */
  expiresAt: string | null;
}

/**
 * Refresh an expired Square access token using a stored refresh token via
 * Square's OAuth2 token endpoint (grant_type=refresh_token).
 *
 * Returns the new access token (+ rotated refresh token and expiry), or null if
 * a refresh isn't possible (mock mode, no refresh token, missing OAuth app
 * credentials, or Square rejects the request). Callers persist the result
 * encrypted and treat null as "integration disconnected — reconnect required".
 */
export const refreshAccessToken = async (
  refreshToken: string | null | undefined,
): Promise<RefreshedSquareToken | null> => {
  if (isMockMode() || !refreshToken) return null;

  const clientId = process.env.SQUARE_APPLICATION_ID ?? process.env.SQUARE_CLIENT_ID;
  const clientSecret = process.env.SQUARE_APPLICATION_SECRET ?? process.env.SQUARE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[square] token refresh skipped — SQUARE_APPLICATION_ID/SECRET not configured');
    return null;
  }

  try {
    const res = await fetch(`${getOAuthBaseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': SQUARE_VERSION,
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      console.error(`[square] token refresh failed: ${res.status}`);
      return null;
    }

    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: string;
    };
    if (!json.access_token) return null;

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_at ?? null,
    };
  } catch (err) {
    console.error('[square] token refresh error:', (err as Error).message);
    return null;
  }
};
