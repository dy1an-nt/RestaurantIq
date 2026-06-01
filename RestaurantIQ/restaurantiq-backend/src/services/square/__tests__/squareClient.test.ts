import { refreshAccessToken } from '../squareClient';

describe('squareClient.refreshAccessToken', () => {
  const original = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env.USE_MOCK;
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.SQUARE_APPLICATION_ID = 'sq-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'sq-app-secret';
  });

  afterEach(() => {
    process.env = { ...original };
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('returns null in mock mode', async () => {
    process.env.USE_MOCK = 'true';
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    expect(await refreshAccessToken('rt')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when no refresh token is provided', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    expect(await refreshAccessToken(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when OAuth app credentials are missing', async () => {
    delete process.env.SQUARE_APPLICATION_ID;
    delete process.env.SQUARE_CLIENT_ID;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    expect(await refreshAccessToken('rt')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes successfully and returns the new credentials', async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_at: expiresAt,
      }),
    }) as any;

    const result = await refreshAccessToken('old-refresh');
    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt,
    });

    // Hits the sandbox OAuth host with the refresh_token grant.
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://connect.squareupsandbox.com/oauth2/token');
    expect(JSON.parse(init.body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it('returns null when Square responds with a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    expect(await refreshAccessToken('old-refresh')).toBeNull();
  });

  it('returns null when the response omits an access token', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: 'x' }),
    }) as any;
    expect(await refreshAccessToken('old-refresh')).toBeNull();
  });
});
