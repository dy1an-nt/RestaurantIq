/**
 * DoorDash ingestion entry point — the second order source, structurally a
 * mirror of services/square/ingestSquare.ts.
 *
 * Pulls catalog → upserts menu_items, pulls orders → upserts orders +
 * order_items, then rebuilds daily_summaries and regenerates alerts. All writes
 * go through the SHARED persistence layer (services/ingestion/persistence), so
 * DoorDash data dedupes, links, and aggregates exactly like Square — and flows
 * into the same daily_summaries that margins, insights, and alerts read from.
 *
 * Every record is tagged source='doordash'; logs are prefixed [doordash].
 */
import { supabase } from '../../db';
import { decryptTokenSafe, encryptToken } from '../../lib/tokenCrypto';
import {
  getDoorDashClient,
  isMockMode,
  refreshAccessToken,
  DOORDASH_SOURCE,
} from './doordashClient';
import { normalizeCatalogItem, normalizeOrder } from './normalizers';
import { IngestResult, MenuItemRow, NormalizedOrder } from '../ingestion/types';
import {
  upsertCatalog,
  upsertOrders,
  refreshDailySummaries,
  runAlerts,
} from '../ingestion/persistence';

interface DoorDashCreds {
  id: string;
  doordash_store_id: string | null;
  doordash_access_token: string | null;
  doordash_refresh_token: string | null;
  doordash_token_expires_at: string | null;
}

const loadRestaurantCreds = async (restaurantId: string): Promise<DoorDashCreds> => {
  const { data, error } = await supabase
    .from('restaurants')
    .select(
      'id, doordash_store_id, doordash_access_token, doordash_refresh_token, doordash_token_expires_at',
    )
    .eq('id', restaurantId)
    .single();

  if (error) throw new Error(`Restaurant lookup failed: ${error.message}`);
  if (!data) throw new Error('Restaurant not found');
  return data as DoorDashCreds;
};

/**
 * Return a usable DoorDash access token, refreshing it first if it has expired
 * (or is about to) and a refresh token is available. A refreshed token is
 * persisted back to the restaurant row, encrypted — mirroring the connect path.
 */
export const ensureFreshToken = async (restaurant: DoorDashCreds): Promise<string> => {
  const current = decryptTokenSafe(restaurant.doordash_access_token ?? '');

  const expiresAt = restaurant.doordash_token_expires_at
    ? new Date(restaurant.doordash_token_expires_at).getTime()
    : null;
  // 60s skew buffer so we don't hand back a token that dies mid-sync.
  const expired = expiresAt !== null && expiresAt - 60_000 <= Date.now();

  if (!expired) return current;

  const refreshToken = restaurant.doordash_refresh_token
    ? decryptTokenSafe(restaurant.doordash_refresh_token)
    : null;

  const refreshed = await refreshAccessToken(refreshToken);
  if (!refreshed) {
    // Couldn't refresh — fall back to the existing token and let the API call
    // surface a 401 with a clear message rather than failing opaquely here.
    console.error('[doordash] access token expired and refresh unavailable — re-auth required');
    return current;
  }

  const { error } = await supabase
    .from('restaurants')
    .update({
      doordash_access_token: encryptToken(refreshed.accessToken),
      doordash_token_expires_at: refreshed.expiresAt,
    })
    .eq('id', restaurant.id);
  if (error) console.error('[doordash] failed to persist refreshed token:', error.message);
  else console.error('[doordash] refreshed access token');

  return refreshed.accessToken;
};

export const ingestDoorDash = async (restaurantId: string): Promise<IngestResult> => {
  const restaurant = await loadRestaurantCreds(restaurantId);

  // Live mode requires a connected store; mock mode generates its own data.
  if (!isMockMode() && !restaurant.doordash_store_id) {
    throw new Error('Restaurant has no doordash_store_id — call /connect first.');
  }

  const accessToken = isMockMode() ? null : await ensureFreshToken(restaurant);
  const client = getDoorDashClient({
    accessToken,
    storeId: restaurant.doordash_store_id,
  });

  // 1. Catalog
  const rawCatalog = await client.fetchCatalog();
  const catalogRows: MenuItemRow[] = [];
  for (const item of rawCatalog) {
    const row = normalizeCatalogItem(item, restaurantId);
    if (row) catalogRows.push(row);
  }
  const externalToInternal = await upsertCatalog(catalogRows, DOORDASH_SOURCE);

  // 2. Orders
  const rawOrders = await client.fetchOrders();
  const orderRows: NormalizedOrder[] = [];
  for (const o of rawOrders) {
    const norm = normalizeOrder(o, restaurantId);
    if (norm) orderRows.push(norm);
  }
  const orderCount = await upsertOrders(orderRows, externalToInternal, DOORDASH_SOURCE);

  // 3. Recompute daily_summaries (source-agnostic — now includes DoorDash).
  await refreshDailySummaries(restaurantId);

  // 4. Regenerate alerts from the freshly rebuilt summaries (fire-and-forget).
  await runAlerts(restaurantId, DOORDASH_SOURCE);

  console.error(
    `[doordash] sync complete: ${catalogRows.length} catalog item(s), ${orderCount} new order(s)`,
  );

  return {
    ok: true,
    mock: isMockMode(),
    catalogCount: catalogRows.length,
    orderCount,
  };
};
