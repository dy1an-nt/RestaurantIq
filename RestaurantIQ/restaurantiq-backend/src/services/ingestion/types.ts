/**
 * Shared types for the order-source ingestion pipeline.
 *
 * RestaurantIQ promises "unified orders" across multiple channels. To make that
 * real (and not Square-only), every source — Square, DoorDash, and any future
 * integration — normalizes its payloads into these same row shapes and then
 * hands them to the shared persistence layer (./persistence.ts).
 *
 * The only thing that varies per source is `source`, which is stamped onto every
 * row so downstream analytics can attribute revenue to the right channel.
 */

/** Every channel that can write into orders / order_items / menu_items. */
export type OrderSource = 'square' | 'doordash';

export interface MenuItemRow {
  restaurant_id: string;
  name: string;
  category: string;
  price_cents: number;
  cost_cents: number;
  source: OrderSource;
  /** The source POS's own item id, used for idempotent upserts + order linkage. */
  external_id?: string;
}

export interface OrderRow {
  restaurant_id: string;
  source: OrderSource;
  total_cents: number;
  ordered_at: string; // ISO timestamp
  /** The source's own order id, used to dedupe on re-sync. */
  external_id?: string;
}

export interface OrderItemRow {
  // order_id is filled in by the persistence layer after the order row is inserted.
  menu_item_external_id: string | null;
  quantity: number;
  unit_price_cents: number;
}

/** One order plus its line items, as produced by a source normalizer. */
export interface NormalizedOrder {
  order: OrderRow;
  items: OrderItemRow[];
}

/** Uniform result shape returned by every ingest service + the /sync route. */
export interface IngestResult {
  ok: boolean;
  mock?: boolean;
  catalogCount: number;
  orderCount: number;
  /** Square-only: set when the legacy Payments API fallback was used. */
  fallbackUsedPayments?: boolean;
  message?: string;
}
