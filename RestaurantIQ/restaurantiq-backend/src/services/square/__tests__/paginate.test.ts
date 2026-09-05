/**
 * Unit tests for bounded Square cursor pagination.
 *
 * The bounds exist because the scheduler's sync timeout is a Promise.race that
 * cannot cancel a running ingest. Verified here:
 *   - a normal multi-page walk collects every page in order,
 *   - a cursor that never resolves stops at the page cap instead of looping,
 *   - an over-budget walk stops on the deadline,
 *   - both bounds throw rather than returning a silently partial result.
 */

import {
  collectPages,
  MAX_PAGES_PER_ENDPOINT,
  INGEST_PAGE_BUDGET_MS,
} from '../paginate';

const farFuture = () => Date.now() + 10 * 60 * 1000;

describe('collectPages', () => {
  it('walks every page and returns the items in order', async () => {
    const pages = [
      { items: ['a', 'b'], cursor: 'c1' },
      { items: ['c'], cursor: 'c2' },
      { items: ['d'], cursor: undefined },
    ];
    const seenCursors: Array<string | undefined> = [];

    const out = await collectPages<string>(
      'catalog',
      async (cursor) => {
        seenCursors.push(cursor);
        return pages[seenCursors.length - 1];
      },
      { deadline: farFuture() },
    );

    expect(out).toEqual(['a', 'b', 'c', 'd']);
    // First request has no cursor; each later one carries the previous page's.
    expect(seenCursors).toEqual([undefined, 'c1', 'c2']);
  });

  it('returns an empty array when the first page is empty', async () => {
    const out = await collectPages<string>(
      'orders',
      async () => ({ items: [], cursor: undefined }),
      { deadline: farFuture() },
    );
    expect(out).toEqual([]);
  });

  it('stops at the page cap when the cursor never resolves', async () => {
    const fetchPage = jest.fn(async () => ({ items: ['x'], cursor: 'always-more' }));

    await expect(
      collectPages<string>('catalog', fetchPage, { deadline: farFuture(), maxPages: 3 }),
    ).rejects.toThrow(/3-page cap/);

    // Bounded: exactly maxPages requests, not an unbounded loop.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('does not throw when the last allowed page ends the walk', async () => {
    let n = 0;
    const out = await collectPages<number>(
      'catalog',
      async () => {
        n += 1;
        return { items: [n], cursor: n < 3 ? `c${n}` : undefined };
      },
      { deadline: farFuture(), maxPages: 3 },
    );
    expect(out).toEqual([1, 2, 3]);
  });

  it('stops on the deadline even when pages are still available', async () => {
    // Clock jumps past the deadline after the first page is fetched.
    let clock = 1_000;
    const fetchPage = jest.fn(async () => {
      clock += 60_000;
      return { items: ['x'], cursor: 'more' };
    });

    await expect(
      collectPages<string>('orders', fetchPage, {
        deadline: 30_000,
        now: () => clock,
      }),
    ).rejects.toThrow(/exceeded its .*budget after 1 page/);

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws instead of returning a partial pull', async () => {
    // A caller must never receive the pages collected before the bound was
    // hit: a partial pull recorded as success is silently stale data.
    const fetchPage = async () => ({ items: ['x'], cursor: 'always-more' });
    const result = await collectPages<string>('catalog', fetchPage, {
      deadline: farFuture(),
      maxPages: 2,
    }).catch((err: Error) => err);

    expect(result).toBeInstanceOf(Error);
  });

  it('keeps the ingest budget under the scheduler sync timeout', () => {
    // SYNC_TIMEOUT_MS is 90s in syncScheduler.ts. Importing it here would make
    // a cycle (syncScheduler imports ingestSquare imports paginate), so the
    // relationship is asserted against the literal instead.
    expect(INGEST_PAGE_BUDGET_MS).toBeLessThan(90 * 1000);
    expect(MAX_PAGES_PER_ENDPOINT).toBeGreaterThan(0);
  });
});
