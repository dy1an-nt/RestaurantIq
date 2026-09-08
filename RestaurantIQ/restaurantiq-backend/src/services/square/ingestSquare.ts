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
 * Last successful Square sync for this restaurant, or null if it has never
 * completed one. This is the watermark an incremental orders pull resumes from.
 *
 * Best effort: a failed lookup returns null, which ordersStartAt treats as a
 * first sync and bounds accordingly. That errs toward re-fetching orders we
 * already have, which dedup absorbs, rather than skipping a window, which
 * nothing ever revisits.
 */
const loadOrdersWatermark = async (restaurantId: string): Promise<string | null> => {
  const { data, error } = await supabase
    .from('integration_sync_status')
    .select('last_success_at')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'square')
    .maybeSingle();

  if (error) {
    console.error('[square] watermark lookup failed:', error.message);
    return null;
  }
  return data?.last_success_at ?? null;
};

/**
 * How far back before the watermark to re-request orders.
 *
 * Square's `closed_at` can lag when an order becomes queryable, our clock and
 * theirs drift, and a sync that died mid-pagination persisted only part of its
 * window. One day of overlap covers all three.
 */
export const ORDERS_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * How much history a restaurant's FIRST sync pulls.
 *
 * Deliberately bounded, and deliberately modest. A first sync that exceeds
 * INGEST_PAGE_BUDGET_MS or MAX_ORDER_PAGES throws, which writes no watermark,
 * so the next attempt re-requests the identical window and fails identically.
 * Unlike a later sync, there is nothing to fall back to: the account never
 * recovers on its own. The bound therefore has to sit below what the budget can
 * actually walk for a busy restaurant, not merely below what sounds generous.
 * At 150 to 200 orders a day, a year is 55k to 73k orders, past what 75s and
 * 500 pages can carry.
 *
 * 90 days matches refreshDailySummaries's one-time coverage bootstrap (also 90
 * days, migration 027), so a restaurant's first sync and its first summary
 * recompute cover the same history, and it covers week-over-week trends and
 * time-of-day heatmaps outright. Raise it only alongside a chunked backfill
 * that persists partial progress.
 */
export const FIRST_SYNC_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Decide the earliest `closed_at` to request orders from.
 *
 * Square's searchOrders was unfiltered, so every sync re-walked the
 * restaurant's entire completed-order history. Returning a start time here is
 * what makes the pull incremental.
 *
 * The two error directions are not symmetric, and that drives the policy.
 * Re-pulling an order already stored costs one row in a dedup SELECT, because
 * upsertOrders skips (restaurant_id, source, external_id) it already has.
 * Missing an order loses it permanently, because nothing ever goes back for
 * that window. So every ambiguous case here resolves toward pulling more.
 *
 * @param lastSuccessAt - ISO timestamp of the last successful sync, or null if
 *                        this restaurant has never completed one.
 * @returns an RFC 3339 timestamp to pull orders from.
 */
export const ordersStartAt = (lastSuccessAt: string | null): string => {
  const now = Date.now();
  const parsed = lastSuccessAt ? new Date(lastSuccessAt).getTime() : NaN;

  // Never synced, or a watermark we cannot parse. An unparseable value is
  // treated as absent rather than as zero: resuming from the epoch would be
  // the unbounded walk this function exists to avoid.
  if (!Number.isFinite(parsed)) {
    return new Date(now - FIRST_SYNC_LOOKBACK_MS).toISOString();
  }

  // Clamp forward watermarks. A clock skew that puts last_success_at in the
  // future would otherwise ask Square for orders closed after now, which
  // returns nothing and silently stops ingesting.
  const start = Math.min(parsed - ORDERS_OVERLAP_MS, now - ORDERS_OVERLAP_MS);
  return new Date(start).toISOString();
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
  // Resume from the last successful sync instead of re-walking all history.
  // The SDK requires the sort field to match the filtered timestamp, so
  // closedAt pairs with the CLOSED_AT sort already in this query; changing one
  // without the other makes Square reject the request.
  const ordersStart = ordersStartAt(await loadOrdersWatermark(restaurantId));
  let orderRows: NormalizedOrder[] = [];
  try {
    orderRows = await collectPages<NormalizedOrder>(
      'orders',
      async (cursor) => {
        const { result } = await client.ordersApi.searchOrders({
          locationIds: [locationId],
          cursor,
          query: {
            filter: {
              stateFilter: { states: ['COMPLETED'] },
              dateTimeFilter: { closedAt: { startAt: ordersStart } },
            },
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

  const { count: orderCount, insertedDates } = await upsertOrders(orderRows, externalToInternal, 'square');

  // 3. Recompute daily_summaries (source-agnostic — aggregates every channel).
  await refreshDailySummaries(restaurantId, { insertedOrderDates: insertedDates });

  // 4. Regenerate alerts from the freshly rebuilt summaries (fire-and-forget).
  await runAlerts(restaurantId, 'square');

  return {
    ok: true,
    catalogCount: catalogRows.length,
    orderCount,
    fallbackUsedPayments,
  };
};
