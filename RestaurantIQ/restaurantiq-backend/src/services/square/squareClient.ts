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
