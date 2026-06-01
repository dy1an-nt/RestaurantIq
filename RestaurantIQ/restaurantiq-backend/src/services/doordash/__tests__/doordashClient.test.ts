/**
 * Tests for the DoorDash API client.
 *
 * Sprint K goals #1 (Square-parity coverage) and #3 (validate/lock response
 * shapes). Since DoorDash's Marketplace endpoints are partner-gated and no
 * sandbox credentials are available, the "real shape" contract is pinned here
 * against a mocked fetch: these tests document and enforce exactly which JSON
 * envelopes the client tolerates (json.items/json.data for catalog,
 * json.orders/json.data for orders) so the parsing fallbacks can't silently
 * drift. See docs/weekly-summary/week-K-findings.md for the assumption log.
 */
import {
  getDoorDashClient,
  isMockMode,
  refreshAccessToken,
  DOORDASH_SOURCE,
} from '../doordashClient';

const originalEnv = { ...process.env };
const realFetch = global.fetch;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.USE_MOCK;
  delete process.env.DOORDASH_API_BASE_URL;
});

afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('constants', () => {
  it('tags its source as doordash', () => {
    expect(DOORDASH_SOURCE).toBe('doordash');
  });
});

describe('isMockMode', () => {
  it('is true for USE_MOCK=true or 1, false otherwise', () => {
    process.env.USE_MOCK = 'true';
    expect(isMockMode()).toBe(true);
    process.env.USE_MOCK = '1';
    expect(isMockMode()).toBe(true);
    process.env.USE_MOCK = 'false';
    expect(isMockMode()).toBe(false);
    delete process.env.USE_MOCK;
    expect(isMockMode()).toBe(false);
  });
});

describe('mock mode', () => {
  beforeEach(() => {
    process.env.USE_MOCK = 'true';
  });

  it('serves a deterministic catalog without any network call', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const client = getDoorDashClient();
    const catalog = await client.fetchCatalog();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog).toHaveLength(5);
    expect(catalog.every((c) => c.id && c.name)).toBe(true);
    // Stable, prefixed ids → idempotent re-syncs.
    expect(catalog.every((c) => c.id.startsWith('dd-item-'))).toBe(true);
  });

  it('serves deterministic orders with stable ids across repeated calls', async () => {
    const a = await getDoorDashClient().fetchOrders();
    const b = await getDoorDashClient().fetchOrders();

    expect(a).toHaveLength(12); // 2/day across 6 days
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id)); // identical → dedupes on re-sync
    expect(new Set(a.map((o) => o.id)).size).toBe(12); // all unique
    // Every order carries a total and at least one line item.
    expect(a.every((o) => typeof o.total === 'number' && (o.items?.length ?? 0) > 0)).toBe(true);
  });

  it('mock orders reference only ids that exist in the mock catalog', async () => {
    const client = getDoorDashClient();
    const catalogIds = new Set((await client.fetchCatalog()).map((c) => c.id));
    const orders = await client.fetchOrders();
    const lineIds = orders.flatMap((o) => (o.items ?? []).map((l) => l.item_id));
    expect(lineIds.every((id) => catalogIds.has(id))).toBe(true);
  });
});

describe('live mode — credential guards', () => {
  it('throws when no access token is available', () => {
    delete process.env.DOORDASH_ACCESS_TOKEN;
    expect(() => getDoorDashClient({ storeId: 'st-1' })).toThrow(/access token/i);
  });

  it('throws when a token is present but the store id is missing', () => {
    expect(() => getDoorDashClient({ accessToken: 'tok', storeId: null })).toThrow(/store id/i);
  });
});

describe('live mode — response shape parsing', () => {
  const mockFetchJson = (json: any, ok = true, status = 200) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }) as any;
  };

  const client = () => getDoorDashClient({ accessToken: 'tok', storeId: 'st-1' });

  it('parses catalog from the json.items envelope', async () => {
    mockFetchJson({ items: [{ id: 'a', name: 'A', price: 100 }] });
    const catalog = await client().fetchCatalog();
    expect(catalog).toEqual([{ id: 'a', name: 'A', price: 100 }]);
  });

  it('falls back to json.data for catalog when items is absent', async () => {
    mockFetchJson({ data: [{ id: 'b', name: 'B' }] });
    expect(await client().fetchCatalog()).toEqual([{ id: 'b', name: 'B' }]);
  });

  it('returns an empty catalog when neither items nor data is present', async () => {
    mockFetchJson({ unexpected: true });
    expect(await client().fetchCatalog()).toEqual([]);
  });

  it('parses orders from the json.orders envelope', async () => {
    mockFetchJson({ orders: [{ id: 'o1', total: 500 }] });
    expect(await client().fetchOrders()).toEqual([{ id: 'o1', total: 500 }]);
  });

  it('falls back to json.data for orders when orders is absent', async () => {
    mockFetchJson({ data: [{ id: 'o2', total: 600 }] });
    expect(await client().fetchOrders()).toEqual([{ id: 'o2', total: 600 }]);
  });

  it('sends the bearer token and hits the store-scoped orders path', async () => {
    // NOTE: BASE_URL is resolved once at module load, so DOORDASH_API_BASE_URL
    // must be set in the process env before import — it is not overridable per
    // call. We therefore assert against the default host. (See findings doc.)
    mockFetchJson({ orders: [] });
    await client().fetchOrders();

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://openapi.doordash.com/marketplace/api/v1/stores/st-1/orders');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('throws a descriptive error on a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'upstream unavailable',
    }) as any;
    await expect(client().fetchCatalog()).rejects.toThrow(/503/);
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    process.env.DOORDASH_CLIENT_ID = 'dd-client';
    process.env.DOORDASH_CLIENT_SECRET = 'dd-secret';
  });

  it('returns null in mock mode without calling the network', async () => {
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

  it('returns null when OAuth client credentials are missing', async () => {
    delete process.env.DOORDASH_CLIENT_ID;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    expect(await refreshAccessToken('rt')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes successfully and computes an expiry from expires_in', async () => {
    const before = Date.now();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    }) as any;

    const result = await refreshAccessToken('old-refresh');
    expect(result!.accessToken).toBe('new-access');
    const expiryMs = new Date(result!.expiresAt).getTime();
    // ~1h out (allow generous slack for test execution).
    expect(expiryMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5000);

    // Posts the refresh_token grant as form-encoded body.
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://openapi.doordash.com/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.body.toString()).toContain('grant_type=refresh_token');
    expect(init.body.toString()).toContain('refresh_token=old-refresh');
  });

  it('returns null when DoorDash responds with a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    expect(await refreshAccessToken('old-refresh')).toBeNull();
  });

  it('returns null when the response omits an access token', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_in: 3600 }),
    }) as any;
    expect(await refreshAccessToken('old-refresh')).toBeNull();
  });

  it('returns null and swallows network errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
    expect(await refreshAccessToken('old-refresh')).toBeNull();
  });
});
