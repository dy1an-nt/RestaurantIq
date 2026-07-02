/**
 * Cross-router tenant-isolation sweep (engineering review H5).
 *
 * The insights suite introduced the HTTP harness; this file extends it to the
 * ENTIRE mounted route surface. Three layers of guarantee:
 *
 *   1. Auth sweep — every route on every router is discovered by introspecting
 *      the Express route tables (so a newly added endpoint is swept
 *      automatically, no manual list to forget) and must 401 without a token.
 *   2. No-restaurant sweep — every route behind requireRestaurant must 404 for
 *      an authenticated user with no restaurant row.
 *   3. Wrong-tenant matrix — for every route that touches a tenant-scoped
 *      resource via URL param or body, a valid token for user A against user
 *      B's resource must 403/404 AND leave B's rows untouched. Reads must
 *      never include B's rows.
 *
 * Real code under test: authMiddleware (actual HS256 JWT verification),
 * requireRestaurant, every router, chatService's ownership check, and real
 * AES-GCM token encryption on the integrations routes. Mocked: the DB (fake
 * Supabase), rate limiters, the chat daily cap, and every paid AI/sync call —
 * none of which is the boundary under test, and none of which is reachable in
 * a wrong-tenant request anyway (that's what these tests prove).
 */
jest.mock('../../db', () => {
  const { createFakeSupabase: make } = require('../../services/ingestion/__tests__/fakeSupabase');
  return { supabase: make() };
});

jest.mock('../../middleware/rateLimit', () => ({
  createAiRateLimiter:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/chatDailyCap', () => ({
  chatDailyCap: (_req: unknown, _res: unknown, next: () => void) => next(),
  getChatUsage: jest.fn(async () => ({
    messagesToday: 0,
    dailyCap: 30,
    resetsAt: '2099-01-01T00:00:00.000Z',
  })),
}));

const generateInsightsMock = jest.fn();
jest.mock('../../services/anthropicService', () => ({
  ...jest.requireActual('../../services/anthropicService'),
  generateInsights: (...args: unknown[]) => generateInsightsMock(...args),
}));

const generateMarketingCopyMock = jest.fn();
jest.mock('../../services/marketingService', () => ({
  generateMarketingCopy: (...args: unknown[]) => generateMarketingCopyMock(...args),
}));

const syncIntegrationMock = jest.fn();
jest.mock('../../services/syncScheduler', () => ({
  syncIntegration: (...args: unknown[]) => syncIntegrationMock(...args),
}));

// HS256 auth mode: SUPABASE_URL must be unset BEFORE the auth middleware first
// resolves its mode (it caches after the first request). The encryption key
// makes the integrations routes exercise REAL token crypto.
delete process.env.SUPABASE_URL;
process.env.SUPABASE_JWT_SECRET = 'test-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ANTHROPIC_API_KEY = 'test-key';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { supabase } from '../../db';
import restaurantRoutes from '../restaurant';
import menuItemsRouter from '../menuItems';
import insightsRouter from '../insights';
import squareIntegrationRouter from '../integrations/square';
import doordashIntegrationRouter from '../integrations/doordash';
import syncStatusRouter from '../integrations/syncStatus';
import alertsRouter from '../alerts';
import analyticsRouter from '../analytics';
import marketingRouter from '../marketing';
import chatRouter from '../chat';
import advisorRouter from '../advisor';

const fake = supabase as any;

// Mirror server.ts exactly (minus the unauthenticated /health mounts).
const MOUNTS: Array<[string, express.Router]> = [
  ['/api/restaurants', menuItemsRouter],
  ['/api/restaurant', restaurantRoutes],
  ['/api/insights', insightsRouter],
  ['/api/integrations/square', squareIntegrationRouter],
  ['/api/integrations/doordash', doordashIntegrationRouter],
  ['/api/integrations', syncStatusRouter],
  ['/api/alerts', alertsRouter],
  ['/api/analytics', analyticsRouter],
  ['/api/marketing', marketingRouter],
  ['/api/chat', chatRouter],
  ['/api/advisor', advisorRouter],
];

const app = express();
app.use(express.json());
for (const [path, router] of MOUNTS) app.use(path, router);

// ── Route discovery ───────────────────────────────────────────────────────────
// Walk each router's stack so the sweeps cover every registered endpoint —
// including ones added after this file was written.

interface DiscoveredRoute {
  mount: string;
  method: string;
  path: string; // full path, params still in :name form
}

const discoverRoutes = (): DiscoveredRoute[] => {
  const out: DiscoveredRoute[] = [];
  for (const [mount, router] of MOUNTS) {
    for (const layer of (router as any).stack) {
      if (!layer.route) continue;
      const paths: string[] = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          const full = p === '/' ? mount : `${mount}${p}`;
          out.push({ mount, method: method.toUpperCase(), path: full });
        }
      }
    }
  }
  return out;
};

const ROUTES = discoverRoutes();
const urlFor = (route: DiscoveredRoute): string => route.path.replace(/:[^/]+/g, 'x');
const send = (method: string, url: string) =>
  (request(app) as any)[method.toLowerCase()](url);

// Routers where requireRestaurant resolves the tenant before any handler runs.
const TENANT_RESOLVED_MOUNTS = new Set([
  '/api/insights',
  '/api/integrations', // syncStatus router only (square/doordash have their own mounts)
  '/api/alerts',
  '/api/analytics',
  '/api/marketing',
  '/api/chat',
  '/api/advisor',
]);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tokenFor = (userId: string): string =>
  jwt.sign({ sub: userId }, 'test-secret', { audience: 'authenticated', expiresIn: '1h' });

const USER_A = 'user-a';
const USER_B = 'user-b';
const REST_A = 'rest-a';
const REST_B = 'rest-b';
const asA = { Authorization: `Bearer ${tokenFor(USER_A)}` };

const seedTenants = () => {
  fake.__seed('restaurants', [
    {
      id: REST_A,
      user_id: USER_A,
      name: 'A Diner',
      location: null,
      pos_connected: true,
      delivery_connected: true,
      square_location_id: 'loc-a',
      doordash_store_id: 'store-a',
      square_access_token: 'a-square-token',
      doordash_access_token: 'a-doordash-token',
      doordash_commission_bps: 1500,
      doordash_flat_fee_cents: 0,
    },
    {
      id: REST_B,
      user_id: USER_B,
      name: 'B Bistro',
      location: null,
      pos_connected: true,
      delivery_connected: true,
      square_location_id: 'loc-b',
      doordash_store_id: 'store-b',
      square_access_token: 'b-square-token',
      doordash_access_token: 'b-doordash-token',
      doordash_commission_bps: 3000,
      doordash_flat_fee_cents: 100,
    },
  ]);
};

const seedMenuItems = () => {
  fake.__seed('menu_items', [
    { id: 'item-a', restaurant_id: REST_A, name: 'A Burger', category: 'mains', price_cents: 1000, cost_cents: 300, source: 'square' },
    { id: 'item-b', restaurant_id: REST_B, name: 'B Salad', category: 'mains', price_cents: 900, cost_cents: 250, source: 'square' },
  ]);
};

beforeEach(() => {
  fake.__reset();
  generateInsightsMock.mockReset();
  generateMarketingCopyMock.mockReset();
  syncIntegrationMock.mockReset();
});

// ── 1. Auth sweep ─────────────────────────────────────────────────────────────

describe('auth sweep — every mounted route rejects unauthenticated requests', () => {
  it('discovered the full route surface', () => {
    // If this shrinks, discovery broke (an entire router silently vanished
    // from the sweep is exactly the failure this file exists to prevent).
    expect(ROUTES.length).toBeGreaterThanOrEqual(29);
  });

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    '%s %s → 401 without a token',
    async (_m, _p, route) => {
      const res = await send(route.method, urlFor(route));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ data: null, error: 'Unauthorized' });
    },
  );

  it('401s a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ sub: USER_A }, 'wrong-secret', { audience: 'authenticated' });
    const res = await request(app).get('/api/alerts').set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });
});

// ── 2. No-restaurant sweep ────────────────────────────────────────────────────

describe('requireRestaurant sweep — authenticated user with no restaurant gets 404', () => {
  const guarded = ROUTES.filter((r) => TENANT_RESOLVED_MOUNTS.has(r.mount));

  it('covers the requireRestaurant surface', () => {
    expect(guarded.length).toBeGreaterThanOrEqual(17);
  });

  it.each(guarded.map((r) => [r.method, r.path, r] as const))(
    '%s %s → 404 with no restaurant',
    async (_m, _p, route) => {
      seedTenants(); // other tenants exist; the caller still owns nothing
      const res = await send(route.method, urlFor(route)).set(
        'Authorization',
        `Bearer ${tokenFor('user-with-nothing')}`,
      );
      expect(res.status).toBe(404);
    },
  );
});

// ── 3. Wrong-tenant matrix ────────────────────────────────────────────────────

describe('restaurant routes — /api/restaurant', () => {
  it("GET /:id 404s for another tenant's restaurant", async () => {
    seedTenants();
    const res = await request(app).get(`/api/restaurant/${REST_B}`).set(asA);
    expect(res.status).toBe(404);
  });

  it("PUT /:id 404s and does not rename another tenant's restaurant", async () => {
    seedTenants();
    const res = await request(app)
      .put(`/api/restaurant/${REST_B}`)
      .set(asA)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    const b = fake.__rows('restaurants').find((r: any) => r.id === REST_B);
    expect(b.name).toBe('B Bistro');
  });

  it('GET /me returns only the caller’s restaurant', async () => {
    seedTenants();
    const res = await request(app).get('/api/restaurant/me').set(asA);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.id).toBe(REST_A);
    expect(res.body.data.name).toBe('A Diner');
  });
});

describe('menu items — /api/restaurants/:restaurantId/menu-items', () => {
  it("GET 403s for another tenant's restaurantId", async () => {
    seedTenants();
    seedMenuItems();
    const res = await request(app)
      .get(`/api/restaurants/${REST_B}/menu-items`)
      .set(asA);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
  });

  it("PATCH 403s and does not mutate another tenant's item", async () => {
    seedTenants();
    seedMenuItems();
    const res = await request(app)
      .patch(`/api/restaurants/${REST_B}/menu-items/item-b`)
      .set(asA)
      .send({ cost_cents: 1 });
    expect(res.status).toBe(403);
    const b = fake.__rows('menu_items').find((r: any) => r.id === 'item-b');
    expect(b.cost_cents).toBe(250);
  });

  it("PATCH on the caller's own restaurant 404s for a foreign itemId (no cross-item write)", async () => {
    seedTenants();
    seedMenuItems();
    const res = await request(app)
      .patch(`/api/restaurants/${REST_A}/menu-items/item-b`)
      .set(asA)
      .send({ cost_cents: 1 });
    expect(res.status).toBe(404);
    const b = fake.__rows('menu_items').find((r: any) => r.id === 'item-b');
    expect(b.cost_cents).toBe(250);
  });

  it('GET returns only the owner’s items', async () => {
    seedTenants();
    seedMenuItems();
    const res = await request(app)
      .get(`/api/restaurants/${REST_A}/menu-items`)
      .set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('item-a');
  });
});

describe('alerts — /api/alerts', () => {
  const seedAlerts = () => {
    fake.__seed('alerts', [
      { id: 'alert-a', restaurant_id: REST_A, type: 'no_sales', is_read: false, created_at: '2026-07-01T00:00:00Z' },
      { id: 'alert-b', restaurant_id: REST_B, type: 'no_sales', is_read: false, created_at: '2026-07-01T00:00:00Z' },
    ]);
  };

  it("GET / never includes another tenant's alerts", async () => {
    seedTenants();
    seedAlerts();
    const res = await request(app).get('/api/alerts').set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('alert-a');
  });

  it("POST /read-all leaves other tenants' alerts unread", async () => {
    seedTenants();
    seedAlerts();
    const res = await request(app).post('/api/alerts/read-all').set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(1);
    const b = fake.__rows('alerts').find((r: any) => r.id === 'alert-b');
    expect(b.is_read).toBe(false);
  });

  it("POST /:id/read 404s for another tenant's alert without mutating it (no 403/404 existence oracle — review L1)", async () => {
    seedTenants();
    seedAlerts();
    const res = await request(app).post('/api/alerts/alert-b/read').set(asA);
    expect(res.status).toBe(404);
    const b = fake.__rows('alerts').find((r: any) => r.id === 'alert-b');
    expect(b.is_read).toBe(false);
  });

  it('POST /:id/read returns the SAME 404 for a nonexistent alert (oracle closed)', async () => {
    seedTenants();
    seedAlerts();
    const foreign = await request(app).post('/api/alerts/alert-b/read').set(asA);
    const missing = await request(app).post('/api/alerts/no-such-alert/read').set(asA);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it('POST /:id/read still works for the owner', async () => {
    seedTenants();
    seedAlerts();
    const res = await request(app).post('/api/alerts/alert-a/read').set(asA);
    expect(res.status).toBe(200);
    const a = fake.__rows('alerts').find((r: any) => r.id === 'alert-a');
    expect(a.is_read).toBe(true);
  });
});

describe('chat — /api/chat', () => {
  const seedConversations = () => {
    fake.__seed('chat_conversations', [
      { id: 'conv-a', restaurant_id: REST_A, title: 'A chat', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: 'conv-b', restaurant_id: REST_B, title: 'B chat', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
    ]);
  };

  it("GET /conversations never includes another tenant's conversations", async () => {
    seedTenants();
    seedConversations();
    const res = await request(app).get('/api/chat/conversations').set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data.conversations).toHaveLength(1);
    expect(res.body.data.conversations[0].id).toBe('conv-a');
  });

  it("GET /conversations/:id/messages 404s for another tenant's conversation", async () => {
    seedTenants();
    seedConversations();
    const res = await request(app)
      .get('/api/chat/conversations/conv-b/messages')
      .set(asA);
    expect(res.status).toBe(404);
  });

  it("PATCH /conversations/:id 404s and does not rename another tenant's conversation", async () => {
    seedTenants();
    seedConversations();
    const res = await request(app)
      .patch('/api/chat/conversations/conv-b')
      .set(asA)
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(404);
    const b = fake.__rows('chat_conversations').find((r: any) => r.id === 'conv-b');
    expect(b.title).toBe('B chat');
  });

  it("DELETE /conversations/:id 404s and does not delete another tenant's conversation", async () => {
    seedTenants();
    seedConversations();
    const res = await request(app).delete('/api/chat/conversations/conv-b').set(asA);
    expect(res.status).toBe(404);
    expect(fake.__rows('chat_conversations').some((r: any) => r.id === 'conv-b')).toBe(true);
  });

  it('DELETE /conversations/:id works for the owner', async () => {
    seedTenants();
    seedConversations();
    const res = await request(app).delete('/api/chat/conversations/conv-a').set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(fake.__rows('chat_conversations').some((r: any) => r.id === 'conv-a')).toBe(false);
  });

  it("POST /conversations/:id/messages 404s for another tenant's conversation before any AI call (real chatService ownership check)", async () => {
    seedTenants();
    seedConversations();
    const res = await request(app)
      .post('/api/chat/conversations/conv-b/messages')
      .set(asA)
      .send({ content: 'hello' });
    expect(res.status).toBe(404);
    // No message row leaked into the foreign conversation.
    expect(fake.__rows('chat_messages')).toHaveLength(0);
  });
});

describe('marketing — /api/marketing/generate', () => {
  it("404s for another tenant's menu item and never reaches the AI call", async () => {
    seedTenants();
    seedMenuItems();
    const res = await request(app)
      .post('/api/marketing/generate')
      .set(asA)
      .send({ menuItemId: 'item-b', tone: 'fun', platform: 'instagram' });
    expect(res.status).toBe(404);
    expect(generateMarketingCopyMock).not.toHaveBeenCalled();
  });
});

describe('analytics — /api/analytics', () => {
  it("PATCH /delivery-economics updates only the caller's restaurant", async () => {
    seedTenants();
    const res = await request(app)
      .patch('/api/analytics/delivery-economics')
      .set(asA)
      .send({ doordash_commission_bps: 2000 });
    expect(res.status).toBe(200);
    const rows = fake.__rows('restaurants');
    expect(rows.find((r: any) => r.id === REST_A).doordash_commission_bps).toBe(2000);
    expect(rows.find((r: any) => r.id === REST_B).doordash_commission_bps).toBe(3000);
  });
});

describe('integrations — Square', () => {
  it("POST /connect 403s and does not overwrite another tenant's credentials", async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/square/connect')
      .set(asA)
      .send({ restaurant_id: REST_B, location_id: 'evil-loc', access_token: 'stolen' });
    expect(res.status).toBe(403);
    const b = fake.__rows('restaurants').find((r: any) => r.id === REST_B);
    expect(b.square_access_token).toBe('b-square-token');
    expect(b.square_location_id).toBe('loc-b');
  });

  it("POST /sync 403s for another tenant's restaurant and never dispatches a sync", async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/square/sync')
      .set(asA)
      .send({ restaurant_id: REST_B });
    expect(res.status).toBe(403);
    expect(syncIntegrationMock).not.toHaveBeenCalled();
  });

  it('POST /connect for the owner stores the token ENCRYPTED, never plaintext', async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/square/connect')
      .set(asA)
      .send({ restaurant_id: REST_A, location_id: 'loc-new', access_token: 'sq-plaintext-token' });
    expect(res.status).toBe(200);
    const a = fake.__rows('restaurants').find((r: any) => r.id === REST_A);
    expect(a.square_access_token).not.toBe('sq-plaintext-token');
    expect(a.square_access_token).not.toContain('sq-plaintext-token');
    expect(a.square_access_token).toContain(':'); // versioned iv:cipher format
  });

  it('POST /sync for the owner dispatches through the shared sync path', async () => {
    seedTenants();
    syncIntegrationMock.mockResolvedValue({ ok: true, catalogCount: 3, orderCount: 7 });
    const res = await request(app)
      .post('/api/integrations/square/sync')
      .set(asA)
      .send({ restaurant_id: REST_A });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, catalogCount: 3, orderCount: 7 });
    expect(syncIntegrationMock).toHaveBeenCalledTimes(1);
    expect(syncIntegrationMock.mock.calls[0][0].id).toBe(REST_A);
  });
});

describe('integrations — DoorDash', () => {
  it("POST /connect 403s and does not overwrite another tenant's credentials", async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/doordash/connect')
      .set(asA)
      .send({ restaurant_id: REST_B, store_id: 'evil-store', access_token: 'stolen' });
    expect(res.status).toBe(403);
    const b = fake.__rows('restaurants').find((r: any) => r.id === REST_B);
    expect(b.doordash_access_token).toBe('b-doordash-token');
    expect(b.doordash_store_id).toBe('store-b');
  });

  it("POST /disconnect 403s and leaves another tenant connected", async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/doordash/disconnect')
      .set(asA)
      .send({ restaurant_id: REST_B });
    expect(res.status).toBe(403);
    const b = fake.__rows('restaurants').find((r: any) => r.id === REST_B);
    expect(b.delivery_connected).toBe(true);
  });

  it("POST /sync 403s for another tenant's restaurant and never dispatches a sync", async () => {
    seedTenants();
    const res = await request(app)
      .post('/api/integrations/doordash/sync')
      .set(asA)
      .send({ restaurant_id: REST_B });
    expect(res.status).toBe(403);
    expect(syncIntegrationMock).not.toHaveBeenCalled();
  });
});

// ── 4. Envelope spot-checks on tenant-scoped reads ───────────────────────────

describe('response envelope — tenant-scoped reads return { data, error: null }', () => {
  const cases: Array<[string, () => void]> = [
    ['/api/chat/usage', () => {}],
    ['/api/advisor/forecast', () => {}],
    ['/api/integrations/sync-status', () => {}],
    ['/api/analytics/dashboard', () => {
      fake.__seed('daily_summaries', [
        {
          restaurant_id: REST_A,
          menu_item_id: 'item-a',
          date: '2026-07-01',
          total_quantity: 2,
          total_revenue_cents: 2000,
          total_orders: 2,
          menu_items: [{ name: 'A Burger', category: 'mains' }],
        },
      ]);
    }],
  ];

  it.each(cases.map(([url, seed]) => [url, seed] as const))(
    'GET %s → 200 envelope',
    async (url, seed) => {
      seedTenants();
      seed();
      const res = await request(app).get(url).set(asA);
      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data).toBeDefined();
    },
  );
});
