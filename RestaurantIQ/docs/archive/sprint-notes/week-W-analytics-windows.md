# Week W: Selectable analytics time windows (7 / 30 / 90 days)

## Sprint goal in one sentence

Let an operator choose a 7, 30, or 90 day analytics window, which required making
the `daily_summaries` aggregator range-aware first, because the dashboard reads
summaries and the aggregator only ever wrote a trailing 30 days.

## What shipped, in plain English

- The Analytics page has a 7 / 30 / 90 day segmented control, and the choice
  lives in the URL so a window can be bookmarked and shared.
- Restaurants with less history than the selected window now see a short note
  saying how many days of data actually exist, instead of a silently short chart.
- A live bug was fixed where revenue was understated for larger restaurants.
  Reported totals will go UP after this deploys. That is a correction, not new
  sales activity.
- Historical summaries are now filled in once per restaurant, so choosing 90 days
  returns real data rather than an empty stretch.
- Routine syncs cost the same as before. The wide recompute runs once per
  restaurant, not every fifteen minutes.

## File-by-file

### Backend

- `migrations/027_analytics_windows.sql` adds `restaurants.summaries_covered_from`
  (a date watermark recording how far back `daily_summaries` is known to be
  complete) plus two composite indexes, `daily_summaries (restaurant_id, date)`
  and `orders (restaurant_id, ordered_at)`, which are the exact filter shapes the
  widened window queries use. Idempotent via `IF NOT EXISTS`, wrapped in a
  transaction.
- `src/lib/analyticsWindow.ts` is new and is the single source of truth for the
  window contract: the allowed set `[7, 30, 90]`, the Zod schema that parses and
  defaults the `days` query param, and `resolveWindow(days, now)`, a pure function
  that turns a window size into `{ days, from, to, fromIso }`. It exists so that
  the date string used for the `daily_summaries.date` filter and the ISO timestamp
  used for the `orders.ordered_at` filter are derived once from the same instant.
- `src/lib/__tests__/analyticsWindow.test.ts` covers the boundary math (inclusive
  of today, month rollover, year rollover, UTC stability across time of day) and
  every schema rejection case.
- `src/routes/analytics.ts` gains `validateQuery(windowQuerySchema)` on
  `GET /dashboard`, replaces both hardcoded 30 day filters with `resolveWindow`,
  adds a local `selectAllPaged` helper so both reads page rather than truncate,
  adds a tenant-scoped "earliest order" query, and returns the new `meta` block.
- `src/routes/__tests__/analyticsDashboard.test.ts` is new. It boots the real
  router with the real `authMiddleware` (HS256 fallback path) and real
  `requireRestaurant` against the in-memory Supabase fake, and asserts the 401,
  404, six 400 validation cases, the 200 `meta` shape at each window, and that
  `revenueTrend` and `hourlyDistribution` agree on the lower boundary.
- `src/middleware/validate.ts` provides `validateQuery`, the query-string
  counterpart to `validateBody`. `analytics.ts` is currently its only consumer.
- `src/services/ingestion/persistence.ts` carries most of the sprint. It splits
  the old `refreshDailySummaries` into `recomputeRange` (pure recompute and prune
  over an explicit `[from, to]`) and `refreshDailySummaries` (range selection
  only), adds the `selectPaged` helper, and adds the watermark write.
- `src/services/ingestion/__tests__/persistence.test.ts` adds the bounded-delete
  regression test plus a new describe block covering the bootstrap, the
  bootstrap-runs-once guarantee, and the backdated top-up.
- `src/services/ingestion/__tests__/fakeSupabase.ts` grows real `.order()` sorting
  and `.range()` slicing (applied after filtering, in that order) and a call log
  with `__calls()` / `__clearCalls()`. Without ordered range semantics the fake
  would happily pass code whose paging skips or repeats rows in production.
- `src/services/square/ingestSquare.ts` and
  `src/services/doordash/ingestDoorDash.ts` now thread `insertedDates` from
  `upsertOrders` into `refreshDailySummaries` as `insertedOrderDates`. Square's
  `FIRST_SYNC_LOOKBACK_MS` comment is updated to state that its 90 days is
  deliberately the same 90 days as the coverage bootstrap.
- `src/services/doordash/doordashClient.ts` clamps its mock fixture order
  timestamps to "now". The recompute range now has an upper bound, so a synthetic
  order stamped in the future would fall outside every window.

### Frontend

- `src/components/WindowSelector.tsx` is a new controlled segmented control. It
  is a `role="radiogroup"` of `role="radio"` buttons with `aria-checked`, and it
  owns no state: the page owns the value and the URL sync.
- `src/pages/Analytics.tsx` reads `days` from `useSearchParams`, refetches when it
  changes, aborts the in-flight request on change or unmount, normalizes an
  invalid `?days=` in the URL, omits the param entirely for the default 30, and
  renders the short-history note.

## Key technical decisions

### Widening the read window was the easy half. The aggregator was the blocker.

**Context.** The dashboard reads `daily_summaries`, a pre-aggregated table
recomputed after every sync. `refreshDailySummaries` only ever recomputed the
trailing 30 days.

**Decision.** Make the aggregator range-aware before touching the route.

**Why.** Reading 90 days out of a table that was only ever written for 30 does not
return 90 days of data. It returns 30 days of data and 60 days of nothing. Worse,
the gap is not uniform: any day that was never inside a 30 day window while its
orders already existed has no summary row and never will, because nothing goes
back for it. Shipping the query change alone would have produced a control that
looks broken for exactly the restaurants with the most history.

### Both hot reads were being silently truncated

**Context.** `refreshDailySummaries` and the dashboard both used unranged
Supabase `select()` calls.

**Decision.** Page every correctness-critical read with `.range()` and an explicit
`.order()`. `selectPaged` in `persistence.ts` and `selectAllPaged` in
`analytics.ts` both loop until a short page comes back.

**Why.** PostgREST (the HTTP layer Supabase puts in front of Postgres, which is
what `@supabase/supabase-js` actually talks to) enforces a server-side max-rows
cap, commonly 1000, and returns the short result with no error. There is no
signal. This was already a documented pattern in `docs/sharp-edges.md` from the
scheduler's `readLastAttempts`, and the same shape was live in the summary
recompute. So summaries were being computed from a truncated slice of orders and
revenue was understated with no error surface.

The explicit `.order()` is not decoration. Range paging over an unordered query is
undefined: Postgres may return rows in a different order per request, so page two
can repeat or skip rows from page one.

**Operational consequence, stated plainly.** After this deploys and the first sync
runs, reported revenue will INCREASE for any restaurant whose order or order-item
volume in the recompute window exceeded the cap. Nothing new was sold. The old
number was wrong.

### The stale-row prune could have deleted forward from any date

**Context.** After the upsert, `recomputeRange` deletes rows in the range that no
longer have backing orders. The pre-sprint code did that with
`.gte('date', from)` and no upper bound.

**Decision.** Every delete now carries `restaurant_id`, `.gte('date', from)`, AND
`.lte('date', to)`.

**Why.** The unbounded delete was accidentally safe, not deliberately safe: it was
correct only because `from` was always "30 days ago" and `to` was always today, so
"everything from `from` forward" happened to equal "the range". The moment ranges
can be historical (the bootstrap, the backdated top-up, the explicit-range seam),
a recompute over, say, February on a restaurant with no February orders takes the
zero-orders early-return branch and deletes every summary from February 1 forward,
including today's. Silently, on the next sync, with no error.

**Regression test.** `persistence.test.ts` seeds the steady-state window, then
calls `refreshDailySummaries` with an explicit historical range that has no
orders, and asserts the steady-state rows survive. Against the old unbounded
delete this test fails.

### Four-tier range selection, so 90 days is not recomputed every 15 minutes

**Context.** The scheduler syncs on a short interval. Naively recomputing 90 days
every time multiplies steady-state cost roughly threefold for a feature that only
needs the deep history to be correct once.

**Decision.** `refreshDailySummaries` picks one of four ranges:

1. **Explicit range.** If the caller passes `opts.from`, that range is used
   verbatim. Nothing in production passes this today. It is the seam a future
   chunked backfill will drive.
2. **Coverage bootstrap.** If `restaurants.summaries_covered_from` is NULL or
   later than 90 days ago, recompute the full 90 days once and write the
   watermark.
3. **Steady state.** Otherwise recompute the trailing 30 days, identical in cost
   to the pre-sprint behavior.
4. **Backdated top-up.** Additive to the steady-state path only, and only when
   `upsertOrders` reports it actually inserted orders dated before the
   steady-state floor. At most one extra recompute per sync, over the single
   contiguous range spanning those dates, clamped to the same 90 day floor.

**Why tier 4 exists.** Square's incremental pull can legitimately deliver an order
older than 30 days (a late-closed order, a clock skew, an overlap re-pull). Under
steady state alone, that order would be persisted in `orders` but never
aggregated, so it would exist in the raw data and be invisible in analytics
forever. The trigger is the *inserted* dates, not the fetched dates, so a re-pull
of already-stored orders costs nothing.

**Why `upsertOrders` had to change shape.** It previously returned a plain count.
It now returns `{ count, insertedDates }`, where `insertedDates` is the distinct
set of UTC dates of the orders this call actually inserted. Tier 4 cannot be
computed from anything the caller already had.

### The watermark is written after the recompute, never before

**Context.** `summaries_covered_from` is what stops the bootstrap running twice.

**Decision.** Write it only after `recomputeRange` returns successfully.

**Why.** Writing it first is the intuitive ordering and it is wrong in a way that
does not heal. If the recompute then throws (timeout, PostgREST error, a page
failing mid-loop), the restaurant is permanently marked as covered from 90 days
ago while its summaries are partial or absent. The bootstrap is the only code path
that would have repaired it, and the watermark it just wrote is exactly what stops
it running again. The failure mode is a permanently and silently incomplete
tenant. In the current order, a failed bootstrap simply leaves the watermark NULL
and the next sync retries the whole thing.

### One window, resolved once, threaded everywhere

**Context.** The route previously derived its lower bound twice: once as a
`YYYY-MM-DD` string for the `daily_summaries.date` filter, once as a timestamp
offset for `orders.ordered_at`.

**Decision.** Read the clock once into `now`, call `resolveWindow(days, now)`, and
use its `from` / `to` / `fromIso` for every downstream filter.

**Why.** Two derivations from two clock reads can disagree by however long the
handler took, and the two filters are on different column types, so the drift is
easy to miss. When they disagree, `hourlyDistribution` (from `orders`) covers a
narrower span than `revenueTrend` (from `daily_summaries`), and any average-order-
value figure divides two numbers computed over different ranges. Widening from 30
to 90 days would have made the mismatch larger, not smaller.

`resolveWindow` is pure and takes `now` as an argument rather than reading the
clock. Same reasoning as the injected `now` already in `refreshDailySummaries`: a
function that reads the wall clock internally makes its own tests slide with the
calendar.

### `days_available` is computed from a tenant-scoped query

**Context.** The `meta` block reports `earliest_data_date`, which requires
"the oldest order we have".

**Decision.** The query filters `.eq('restaurant_id', req.restaurantId!)` and
takes `.order('ordered_at').limit(1)`. There is a test asserting a second tenant's
older order does not appear in this restaurant's `meta`.

**Why.** RestaurantIQ's backend uses the Supabase service-role key, which bypasses
row-level security. Tenant isolation is enforced in application code, per query,
with no database backstop on the read path. An "oldest order in the table" query
written without the `.eq()` compiles, runs, returns a plausible date, and leaks a
fact about another tenant's history. This is the standard cost of the service-role
model and it applies to every new query, including small ones added for a UI hint.

`days_available` is then clamped to the window: it is measured from
`max(earliest_data_date, from)`, so a restaurant with five years of history on a
7 day window reports 7, not 1826.

### Validation rejects, it does not coerce

**Context.** `days` arrives as a string, or as an array if the param is repeated.

**Decision.** `.strict()` on the schema, an explicit `refine` against the allowed
set, and a `.default(30)`. `days=14`, `days=abc`, `days=-7`,
`days=7&days=90`, and `day=90` all return 400 with the `{ data, error }` shape.

**Why.** Silently clamping an unknown value to 30 makes a client bug look like a
working feature. `.strict()` specifically catches the typo case: without it,
`?day=90` would be ignored, `days` would default to 30, and the caller would get a
30 day window while believing they asked for 90.

### validateQuery does not write to req.query

**Context.** `validateBody` replaces `req.body` with the parsed result, and the
obvious symmetry is for `validateQuery` to replace `req.query`. It was written
that way first.

**Decision.** The parsed result goes on `req.validatedQuery`. `req.query` is left
untouched. The asymmetry with `validateBody` is deliberate and documented at the
call site.

**Why.** Express 5 makes `req.query` a getter-only property, so assigning to it
throws a TypeError. `req.body` stays an ordinary writable property, so
`validateBody` is unaffected and was left alone. Express 5 is sitting in an open
Dependabot PR against this repo, so the original code was a defect scheduled to
detonate on an upgrade already in the queue. Writing to a separate property costs
nothing and removes the coupling entirely.

The hazard class is worth naming: this is a change that is correct on the
installed version, invisible to every gate, and only fails on a dependency bump.
`tsc`, lint, and the full suite were green with the assignment in place. Nothing
short of reading the Express 5 changelog would have surfaced it.

`src/middleware/__tests__/validate.test.ts` pins the behavior. One test defines
`req.query` as a getter to reproduce the Express 5 shape and asserts the
middleware does not throw; against the old assignment it fails with the same
TypeError Express 5 would raise. Three of its six tests go red if the assignment
returns.

### URL is the source of truth for the frontend, with the default left implicit

**Context.** The control needs to survive a refresh and be shareable.

**Decision.** `useSearchParams` holds `days`. Selecting 30 (the default) DELETES
the param rather than setting `?days=30`. An invalid value already in the URL is
replaced, via `setSearchParams(..., { replace: true })` so it does not add a
history entry.

**Why.** Keeping the default implicit means `/analytics` and `/analytics?days=30`
are the same URL, so no existing bookmark changes meaning and the query param only
ever appears when it carries information. `replace: true` on the normalization
path avoids a back-button trap where going back re-lands on the invalid URL.

## Patterns and concepts you used

- **Separating range selection from range execution.** `refreshDailySummaries`
  decides *what* to recompute; `recomputeRange` executes an explicit
  `[from, to]`. That split is what made the bootstrap, the top-up, and the future
  backfill three call sites of one tested function instead of three variants of
  the same loop. It is also what made the bounded-delete regression testable: the
  test calls the range path directly with dates it chose.
- **Watermark, not full state.** `summaries_covered_from` is a single date that
  answers "how far back is this restaurant known to be complete". It is the same
  idea as the sync scheduler's last-success timestamp: one durable marker,
  advanced only on success, so a crash costs repeated work rather than corrupted
  state.
- **Keyset-free paging with an explicit sort.** `.order()` plus `.range()` is
  offset paging. It is correct here because the underlying set is stable for the
  duration of a recompute, and it requires the sort because offsets over an
  unspecified order are meaningless.
- **Pure boundary math, injected clock.** `resolveWindow` has no I/O and no clock
  read, so its tests are ordinary assertions rather than fake timers. This mirrors
  the pure-versus-impure split already used in `services/square/normalizers.ts`.
- **Asserting on observed calls, not on absent state.** The bootstrap-runs-once
  test clears the fake's call log after the first sync, runs a second, and asserts
  zero `orders` selects carry the 90 day `gte`. The tempting assertion, that the
  watermark did not move, passes even if the expensive query ran again and wrote
  the same value. The property under test is "the wide query did not execute", so
  the test observes execution.
- **Integer cents throughout.** All summary math is `quantity * unit_price_cents`
  in integers. Nothing in the new code introduces a float on a money path.

## Validation evidence

Reported by the sprint's build and QA passes:

- Backend: `tsc --noEmit` exit 0, `npm run lint` exit 0,
  **23 suites / 347 tests passing**.
- Frontend: `tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` exit 0.
- Security pass: no blocking findings. It confirmed that both delete paths in
  `recomputeRange` carry `restaurant_id` plus both date bounds, that the paged
  reads rebuild the fully-filtered query on each iteration rather than reusing a
  builder, and that the watermark write is ordered after the recompute.
- Functional QA pass, first round: the bootstrap, bootstrap-runs-once, and
  backdated top-up paths had **zero test coverage**. Three tests were added. Each
  was verified to fail against deliberately broken production code and to pass
  when the code was restored.
- Functional QA pass, second finding: for a restaurant with no orders,
  `days_available` is 0, and the short-history note rendered "Showing 0 days"
  directly above the "No analytics data yet" empty state, saying the same thing
  twice and contradicting itself. Fixed with a `days_available > 0` guard in
  `shortHistoryNote`.

The endpoint was not exercised against the live database, because the local `.env`
points at production Supabase and migration 027 is not applied anywhere yet. HTTP
behavior is covered by `analyticsDashboard.test.ts` running the real router and
real auth middleware against the in-memory fake.

## Deployment and operational impact

**Migration 027 has not been applied to any environment.**

The ordering is load-bearing and is not merely a best practice here:

1. Apply `027_analytics_windows.sql` through the tracked runner
   (`npm run migrate`, per `docs/migrations.md`).
2. Deploy the backend.
3. Deploy the frontend.

**Why step 1 cannot slip.** `refreshDailySummaries` selects
`summaries_covered_from` on every sync and throws on a PostgREST error. Against a
database without that column, PostgREST returns an error for the unknown column,
so the throw propagates and the sync fails. That is EVERY sync for EVERY
restaurant, not a degraded analytics page. Deploying this code ahead of the
migration takes down ingestion.

Backend before frontend, because the frontend sends `?days=` and reads
`data.meta`. An old backend receiving `?days=90` has no `validateQuery` on the
route, so it would ignore the param and return a 30 day payload with no `meta`,
and `dashboard.meta.days_available` would throw on the client.

**First sync after deploy is heavier.** Every existing restaurant takes the
bootstrap branch exactly once: a 90 day recompute instead of 30. The two new
indexes exist for that read. Steady-state cost afterwards is unchanged.

**Numbers will move.** See the truncation decision above. Communicate the increase
as a correction before anyone notices it as a discrepancy.

## Things we punted

- **The chunked historical backfill is still deferred.** This sprint is its
  prerequisite and left the seam: `refreshDailySummaries(id, { from, to })`
  recomputes an arbitrary range and writes no watermark. It was deprioritized
  because nothing in the product reads past 56 days today, which is
  `forecastService.ts`'s lookback.
- **`revenueTrend` is sparse and the chart uses a category axis.** Days with no
  sales are absent from the array, so the chart compresses them instead of showing
  a gap. A 90 day window makes this much more visible than a 7 day one did. Not a
  correctness bug, and not fixed here. Fixing it means either zero-filling the
  series server-side or switching the axis to a time scale.
- **No rate limiting on `GET /api/analytics/dashboard`.** A caller can request
  `days=90` in a loop against their own tenant. Advisory, and a pre-existing
  pattern across the API rather than something this sprint introduced, but the
  90 day window makes each request more expensive than it used to be.
- **The `SYNC_TIMEOUT_MS` race, now with a longer first sync.**
  `syncScheduler.ts` races the ingest against a 90 second timeout using
  `Promise.race`. `Promise.race` does not cancel the loser. If a first-sync
  bootstrap exceeds 90 seconds, the job is marked failed while the recompute keeps
  running, and a retry can start a second bootstrap overlapping the first. Both
  would write the same watermark, so the end state converges, but the duplicated
  work is real and the interleaving is untested.
- **`docs/schema.md` does not yet document `restaurants.summaries_covered_from`.**
  `schema.md` is the canonical schema doc per `CLAUDE.md`, and migration 027 is
  not reflected in it.
