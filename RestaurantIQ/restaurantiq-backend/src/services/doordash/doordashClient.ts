/**
 * DoorDash API client.
 *
 * Mirrors the shape of squareClient.ts: a thin factory that takes a per-restaurant
 * access token and exposes the two reads ingestion needs — catalog (menu) and
 * orders. DoorDash's real Marketplace order/menu endpoints are partner-gated, so
 * this client talks to a configurable base URL via the stored bearer token.
 *
 * Mock mode
 * ---------
 * Square's USE_MOCK is a no-op because a separate sandbox seeder populates the
 * Square account. DoorDash has no such seeder, so to make the "unified, multi
 * channel orders" promise demonstrable end-to-end, mock mode here returns a
 * small, DETERMINISTIC set of DoorDash catalog items + orders. Deterministic
 * means stable external ids, so re-running /sync is idempotent (the shared
 * persistence layer dedupes on external_id) — which also exercises the real
 * dedup path. Every record is tagged source=doordash downstream.
 */
import { OrderSource } from '../ingestion/types';

export const DOORDASH_SOURCE: OrderSource = 'doordash';

export const isMockMode = (): boolean =>
  process.env.USE_MOCK === 'true' || process.env.USE_MOCK === '1';

/** Raw DoorDash menu item, as returned by the menu endpoint (or the mock). */
export interface DoorDashCatalogItem {
  id: string;
  name: string;
  category?: string;
  price?: number; // integer cents
}

/** Raw DoorDash order line, as returned by the orders endpoint (or the mock). */
export interface DoorDashOrderLine {
  item_id: string;
  quantity: number;
  unit_price?: number; // integer cents
}

/** Raw DoorDash order, as returned by the orders endpoint (or the mock). */
export interface DoorDashOrder {
  id: string;
  total?: number; // integer cents
  created_at?: string; // ISO timestamp
  items?: DoorDashOrderLine[];
}

export interface DoorDashClient {
  fetchCatalog(): Promise<DoorDashCatalogItem[]>;
  fetchOrders(): Promise<DoorDashOrder[]>;
}

export interface DoorDashClientOptions {
  accessToken?: string | null;
  storeId?: string | null;
}

const BASE_URL = process.env.DOORDASH_API_BASE_URL ?? 'https://openapi.doordash.com';

/**
 * Deterministic sandbox data. Stable ids → idempotent re-syncs.
 * Orders are spread across the last few days so trends/heatmaps have shape.
 */
const buildMockCatalog = (): DoorDashCatalogItem[] => [
  { id: 'dd-item-burger', name: 'Smash Burger', category: 'Mains', price: 1295 },
  { id: 'dd-item-fries', name: 'Truffle Fries', category: 'Sides', price: 695 },
  { id: 'dd-item-wings', name: 'Buffalo Wings', category: 'Mains', price: 1095 },
  { id: 'dd-item-salad', name: 'Caesar Salad', category: 'Salads', price: 950 },
  { id: 'dd-item-shake', name: 'Vanilla Shake', category: 'Drinks', price: 575 },
];

const buildMockOrders = (): DoorDashOrder[] => {
  const catalog = buildMockCatalog();
  const orders: DoorDashOrder[] = [];
  // 12 orders across the last 6 days, 2/day, with varied baskets.
  for (let day = 0; day < 6; day++) {
    for (let n = 0; n < 2; n++) {
      const orderedAt = new Date();
      orderedAt.setDate(orderedAt.getDate() - day);
      orderedAt.setHours(11 + n * 7, 30, 0, 0); // lunch + dinner

      // Rotate which items are in this basket so analytics aren't flat.
      const picks = [
        catalog[(day + n) % catalog.length],
        catalog[(day + n + 2) % catalog.length],
      ];
      const items: DoorDashOrderLine[] = picks.map((p, i) => ({
        item_id: p.id,
        quantity: i === 0 ? 2 : 1,
        unit_price: p.price ?? 0,
      }));
      const total = items.reduce((sum, it) => sum + it.quantity * (it.unit_price ?? 0), 0);

      orders.push({
        id: `dd-order-${day}-${n}`, // stable → idempotent
        total,
        created_at: orderedAt.toISOString(),
        items,
      });
    }
  }
  return orders;
};

const authedJson = async (token: string, path: string): Promise<any> => {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DoorDash ${path} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
};

/**
 * Build a DoorDash client.
 *  - Mock mode → deterministic sandbox data (no network).
 *  - Live mode → calls the configured DoorDash API with the stored bearer token.
 */
export const getDoorDashClient = (
  { accessToken, storeId }: DoorDashClientOptions = {},
): DoorDashClient => {
  if (isMockMode()) {
    console.error('[doordash] USE_MOCK=true — serving deterministic sandbox catalog + orders');
    return {
      fetchCatalog: async () => buildMockCatalog(),
      fetchOrders: async () => buildMockOrders(),
    };
  }

  const token = accessToken ?? process.env.DOORDASH_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'No DoorDash access token. Provide one via /api/integrations/doordash/connect or set DOORDASH_ACCESS_TOKEN.',
    );
  }
  if (!storeId) {
    throw new Error('No DoorDash store id — call /connect first.');
  }

  console.error(`[doordash] live mode store=${storeId} token=${token.slice(0, 8)}... len=${token.length}`);

  return {
    fetchCatalog: async () => {
      const json = await authedJson(token, `/marketplace/api/v1/stores/${storeId}/menu`);
      return (json.items ?? json.data ?? []) as DoorDashCatalogItem[];
    },
    fetchOrders: async () => {
      const json = await authedJson(token, `/marketplace/api/v1/stores/${storeId}/orders`);
      return (json.orders ?? json.data ?? []) as DoorDashOrder[];
    },
  };
};

/**
 * Refresh an expired DoorDash access token using a stored refresh token.
 *
 * Returns the new access token + its expiry, or null if refresh isn't possible
 * (no refresh token, mock mode, or the provider rejects it). Callers persist the
 * result encrypted. The endpoint/grant shape follows DoorDash's OAuth2 docs.
 */
export const refreshAccessToken = async (
  refreshToken: string | null | undefined,
): Promise<{ accessToken: string; expiresAt: string } | null> => {
  if (isMockMode() || !refreshToken) return null;

  const clientId = process.env.DOORDASH_CLIENT_ID;
  const clientSecret = process.env.DOORDASH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(`${BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      console.error(`[doordash] token refresh failed: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;

    const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
    return { accessToken: json.access_token, expiresAt };
  } catch (err) {
    console.error('[doordash] token refresh error:', (err as Error).message);
    return null;
  }
};
