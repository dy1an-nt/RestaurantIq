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
 * Square returns up to 1000 catalog objects and 500 orders per page, so 50
 * pages is far beyond any real restaurant while still terminating a cursor
 * that never resolves.
 */
export const MAX_PAGES_PER_ENDPOINT = 50;

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
      throw new Error(
        `Square ${label} pagination exceeded its ${INGEST_PAGE_BUDGET_MS}ms budget after ${pages} page(s).`,
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
