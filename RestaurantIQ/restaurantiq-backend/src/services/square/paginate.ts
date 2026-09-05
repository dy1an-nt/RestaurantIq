/**
 * Bounded cursor pagination for Square's list/search endpoints.
 *
 * Square's `do { ... } while (cursor)` loops were the only unbounded work in a
 * sync. That matters because the scheduler's 90s timeout is a `Promise.race`:
 * it rejects the sync, marks the job failed, and schedules a retry, but it
 * cannot cancel the loser. An ingest that keeps receiving a cursor therefore
 * goes on calling Square long after its job was recorded as failed, while the
 * retry starts a second pull alongside it.
 *
 * Two bounds end the loop from the inside:
 *   - a page cap, which stops a repeating or malformed cursor, and
 *   - a wall-clock deadline shared across every endpoint in one ingest, which
 *     stops a pull that is merely too slow.
 *
 * Hitting either bound THROWS rather than returning what was collected so far.
 * A partial pull that reports success is the failure mode this codebase already
 * fixed once for searchOrders (review H4): it records a green sync over data
 * that is silently incomplete. A thrown error is classified as transient by
 * syncIntegration, so the attempt backs off and retries instead.
 */

/**
 * Maximum pages pulled from a single endpoint per ingest.
 *
 * The DEADLINE is the real bound. This cap exists only to stop a cursor that
 * repeats or never resolves, so it must sit far above any legitimate walk:
 * a cap a real account can reach fails that account permanently, because the
 * throw is classified transient and every retry hits the same cap.
 *
 * A restaurant menu is a few hundred items at Square's 100-per-page default,
 * so 50 pages is untouchable for the catalog.
 */
export const MAX_PAGES_PER_ENDPOINT = 50;

/**
 * Page cap for the orders walk.
 *
 * searchOrders is unfiltered by date, so every sync re-walks the restaurant's
 * entire completed-order history. A busy restaurant passes 50 pages in normal
 * operation and used to sync fine, well inside the wall-clock budget, so the
 * orders cap has to be an order of magnitude higher than the catalog's. The
 * deadline still bounds the wall clock either way.
 */
export const MAX_ORDER_PAGES = 500;

/**
 * Wall-clock budget for all pagination in one ingest.
 *
 * Must stay below SYNC_TIMEOUT_MS in ../syncScheduler.ts (90s). The point is
 * for the loop to end itself just before the scheduler gives up on it, so the
 * pull stops rather than being abandoned mid-flight.
 */
export const INGEST_PAGE_BUDGET_MS = 75_000;

export interface Page<T> {
  items: T[];
  cursor?: string;
}

export interface PaginateOptions {
  /** Epoch ms after which no further page is requested. */
  deadline: number;
  maxPages?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Walk a cursor-paginated Square endpoint to completion, or throw on a bound.
 *
 * @param label - endpoint name, used in the error message only.
 * @param fetchPage - called with the previous page's cursor (undefined first).
 */
export const collectPages = async <T>(
  label: string,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  { deadline, maxPages = MAX_PAGES_PER_ENDPOINT, now = Date.now }: PaginateOptions,
): Promise<T[]> => {
  const collected: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (now() >= deadline) {
      // Report the overrun against the deadline actually in force, not against
      // the module default: callers may pass a tighter one, and an error that
      // quotes the wrong budget sends an operator to the wrong number.
      throw new Error(
        `Square ${label} pagination exceeded its page budget after ${pages} page(s) ` +
          `(${now() - deadline}ms past the deadline).`,
      );
    }
    if (pages >= maxPages) {
      throw new Error(
        `Square ${label} pagination hit the ${maxPages}-page cap. Refusing a partial pull.`,
      );
    }

    const page = await fetchPage(cursor);
    pages += 1;
    collected.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  return collected;
};
