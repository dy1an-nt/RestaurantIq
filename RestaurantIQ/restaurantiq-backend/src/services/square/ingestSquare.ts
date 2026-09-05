import { supabase } from '../../db';
import { getSquareClient, isMockMode, refreshAccessToken } from './squareClient';
import {
  decryptTokenSafe,
  decryptTokenWithMeta,
  encryptToken,
} from '../../lib/tokenCrypto';
import {
  normalizeCatalogItem,
  normalizeOrder,
  normalizePayment,
  MenuItemRow,
} from './normalizers';
import { IngestResult, NormalizedOrder } from '../ingestion/types';
import { collectPages, INGEST_PAGE_BUDGET_MS, MAX_ORDER_PAGES } from './paginate';
import {
  upsertCatalog,
  upsertOrders,
  refreshDailySummaries,
  runAlerts,
} from '../ingestion/persistence';

/** Refresh the access token when it expires within this window. */
export const SQUARE_TOKEN_EXPIRY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

interface SquareCreds {
  id: string;
  square_location_id: string | null;
  square_access_token: string | null;
  square_refresh_token: string | null;
  square_token_expires_at: string | null;
}

/**
 * Look up a restaurant's Square credentials + location.
 */
const loadRestaurantCreds = async (restaurantId: string): Promise<SquareCreds> => {
  const { data, error } = await supabase
    .from('restaurants')
    .select(
      'id, square_location_id, square_access_token, square_refresh_token, square_token_expires_at',
    )
    .eq('id', restaurantId)
    .single();

  if (error) throw new Error(`Restaurant lookup failed: ${error.message}`);
  if (!data) throw new Error('Restaurant not found');
  return data as SquareCreds;
};

/**
 * Return a usable Square access token, refreshing it first if it has expired
 * (or is within the expiry window) and a refresh token is available. A refreshed
 * token is persisted back to the restaurant row, encrypted — mirroring connect.
 *
 * Side effects:
 *  - On a successful refresh: persists the new access/refresh tokens + expiry.
 *  - On a refresh failure: marks the integration disconnected (pos_connected
 *    = false), logs a structured error, and throws so the sync route returns a
 *    clean status instead of repeatedly calling Square with a dead token.
 *  - Opportunistically re-encrypts (migrates) ciphertext that was stored under a
 *    legacy encryption key, even when no refresh is needed.
 */
export const ensureFreshSquareToken = async (restaurant: SquareCreds): Promise<string> => {
  let currentAccess = '';
  let accessNeedsReEncrypt = false;
  if (restaurant.square_access_token) {
    try {
      const meta = decryptTokenWithMeta(restaurant.square_access_token);
      currentAccess = meta.plaintext;
      accessNeedsReEncrypt = !meta.usedActiveKey;
    } catch {
      currentAccess = '';
    }
  }

  const expiresAt = restaurant.square_token_expires_at
    ? new Date(restaurant.square_token_expires_at).getTime()
    : null;
  const expired =
    expiresAt !== null && expiresAt - SQUARE_TOKEN_EXPIRY_WINDOW_MS <= Date.now();

  if (!expired) {
    // Token still valid — opportunistically migrate legacy ciphertext forward.
    if (accessNeedsReEncrypt && currentAccess) {
      const { error } = await supabase
        .from('restaurants')
        .update({ square_access_token: encryptToken(currentAccess) })
        .eq('id', restaurant.id);
      if (error) {
        console.error('[square] failed to migrate access token ciphertext:', error.message);
      }
    }
    return currentAccess;
  }

  const refreshToken = restaurant.square_refresh_token
    ? decryptTokenSafe(restaurant.square_refresh_token)
    : null;

  const refreshed = await refreshAccessToken(refreshToken);
  if (!refreshed) {
    const { error } = await supabase
      .from('restaurants')
      .update({ pos_connected: false })
      .eq('id', restaurant.id);
    if (error) {
      console.error('[square] failed to mark integration disconnected:', error.message);
    }
    console.error(
      '[square] token refresh failed',
      JSON.stringify({
        restaurantId: restaurant.id,
        reason: refreshToken ? 'refresh_request_failed' : 'missing_refresh_token',
      }),
    );
    throw new Error('Square integration disconnected — reconnect required.');
  }

  const updates: Record<string, unknown> = {
    square_access_token: encryptToken(refreshed.accessToken),
    pos_connected: true,
  };
  if (refreshed.expiresAt) updates.square_token_expires_at = refreshed.expiresAt;
  // Square may omit a rotated refresh token; preserve the existing one.
  const nextRefresh = refreshed.refreshToken ?? refreshToken;
  if (nextRefresh) updates.square_refresh_token = encryptToken(nextRefresh);

  const { error } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('id', restaurant.id);
  if (error) {
    console.error('[square] failed to persist refreshed token:', error.message);
  } else {
    console.error('[square] refreshed access token');
  }

  return refreshed.accessToken;
};

/**
 * Main ingestion entry point.
 * Pulls catalog → upserts menu_items, pulls orders (with payment fallback) →
 * upserts orders + order_items, then rebuilds daily_summaries.
 */
export const ingestSquare = async (restaurantId: string): Promise<IngestResult> => {
  if (isMockMode()) {
    return {
      ok: true,
      mock: true,
      catalogCount: 0,
      orderCount: 0,
      message: 'USE_MOCK=true — Square ingestion skipped, dashboard will use seeded data.',
    };
  }

  const restaurant = await loadRestaurantCreds(restaurantId);
  if (!restaurant.square_location_id) {
    throw new Error('Restaurant has no square_location_id — call /connect first.');
  }

  const client = getSquareClient({ accessToken: await ensureFreshSquareToken(restaurant) });
  const locationId = restaurant.square_location_id;

  // One pagination budget for the whole ingest, so a slow catalog pull cannot
  // leave the orders pull running past the scheduler's sync timeout.
  const pageDeadline = Date.now() + INGEST_PAGE_BUDGET_MS;

  // 1. Catalog
  const catalogRows = await collectPages<MenuItemRow>(
    'catalog',
    async (cursor) => {
      const { result } = await client.catalogApi.searchCatalogObjects({
        objectTypes: ['ITEM'],
        cursor,
        includeRelatedObjects: true,
      });
      const items: MenuItemRow[] = [];
      for (const obj of result.objects ?? []) {
        const row = normalizeCatalogItem(obj, restaurantId);
        if (row) items.push(row);
      }
      return { items, cursor: result.cursor };
    },
    { deadline: pageDeadline },
  );

  const externalToInternal = await upsertCatalog(catalogRows, 'square');

  // 2. Orders
  let orderRows: NormalizedOrder[] = [];
  try {
    orderRows = await collectPages<NormalizedOrder>(
      'orders',
      async (cursor) => {
        const { result } = await client.ordersApi.searchOrders({
          locationIds: [locationId],
          cursor,
          query: {
            filter: { stateFilter: { states: ['COMPLETED'] } },
            sort: { sortField: 'CLOSED_AT', sortOrder: 'DESC' },
          },
        });
        const items: NormalizedOrder[] = [];
        for (const o of result.orders ?? []) {
          const norm = normalizeOrder(o, restaurantId);
          if (norm) items.push(norm);
        }
        return { items, cursor: result.cursor };
      },
      // Orders re-walk the full history every sync, so this endpoint needs the
      // higher cap; the shared deadline is what actually bounds the pull.
      { deadline: pageDeadline, maxPages: MAX_ORDER_PAGES },
    );
  } catch (err) {
    console.error('[square] searchOrders failed:', (err as Error).message);
    // A failed orders pull must FAIL the sync — swallowing it here recorded a
    // "success" with zero orders and silently stale data (review H4). The only
    // path that may continue is the explicit payments-API fallback below.
    if (process.env.PAYMENTS_FALLBACK !== 'true') {
      throw new Error(`Square orders pull failed: ${(err as Error).message}`);
    }
  }

  // Payments fallback for legacy Square accounts without Orders API access.
  // Disabled by default — the v37 SDK mishandles undefined positional args.
  // Re-enable with PAYMENTS_FALLBACK=true once we have a need + a fix.
  let fallbackUsedPayments = false;
  if (orderRows.length === 0 && process.env.PAYMENTS_FALLBACK === 'true') {
    fallbackUsedPayments = true;
    try {
      const { result } = await (client.paymentsApi as any).listPayments({ locationId });
      for (const p of result.payments ?? []) {
        const order = normalizePayment(p, restaurantId);
        if (order) orderRows.push({ order, items: [] });
      }
    } catch (err) {
      console.error('[square] listPayments fallback failed:', (err as Error).message);
    }
  }

  const orderCount = await upsertOrders(orderRows, externalToInternal, 'square');

  // 3. Recompute daily_summaries (source-agnostic — aggregates every channel).
  await refreshDailySummaries(restaurantId);

  // 4. Regenerate alerts from the freshly rebuilt summaries (fire-and-forget).
  await runAlerts(restaurantId, 'square');

  return {
    ok: true,
    catalogCount: catalogRows.length,
    orderCount,
    fallbackUsedPayments,
  };
};
