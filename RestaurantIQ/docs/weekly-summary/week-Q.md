# Week Q — Cross-Channel Delivery-Tax Margins

> Sprint J made "unified POS + delivery" technically true — DoorDash became a first-class order source. But until now the product treated a dollar of DoorDash revenue exactly like a dollar of dine-in revenue, which is a lie. DoorDash skims ~20% off the top before the operator sees a cent. Sprint Q is the sprint where RestaurantIQ stops pretending delivery and dine-in are the same business. The headline is one new analytics page that answers a question almost no competitor reconciles: *what does this specific item actually net me on each channel, after the delivery platform takes its cut?* The answer is frequently uncomfortable — a burger that nets $6.10 in the dining room can net $2.40 on DoorDash — and that discomfort is the product.

---

## Sprint goal in one sentence
Ship a per-item, per-channel margin view that subtracts DoorDash's "delivery tax" (commission + flat fee) from delivery revenue, so an owner can see which items to promote in-house, reprice on delivery, or pull off the delivery menu entirely — all with honest integer-cents math and no fabricated numbers.

## What shipped, in plain English
- A new **Channel Margins** page shows, for every menu item, its margin two ways side by side: in-house (Square/Toast/manual) vs DoorDash delivery. The delivery number already has the platform's commission and per-order fees subtracted, so it's the margin you actually keep.
- The owner sets their own DoorDash deal — commission rate (e.g. 20%) and any flat fee per order — in a small settings panel, and every margin on the page recomputes against those numbers.
- The page surfaces the single most painful item: the one whose delivery margin falls furthest below its in-house margin. That's the first thing to reprice or promote in-house.
- Items we don't have a food cost for are honestly set aside in a "Missing Cost" list rather than shown with a fake, flattering margin.
- A grouped bar chart and a sortable table let the owner scan all items at once, sorted by margin gap by default.

---

## File-by-file (every file touched, what it is + why it exists)

### Database

- **`migrations/025_restaurant_delivery_economics.sql`** (new) — Adds two columns to `restaurants`: `doordash_commission_bps` (commission in basis points; 1 bp = 0.01%, default 2000 = 20%, range 0–5000) and `doordash_flat_fee_cents` (per-order flat fee in integer cents, default 0, range 0–2000). Both are `NOT NULL` with defaults so every existing row is populated automatically — no data-fill step, no nullable-column branching in code. The CHECK constraints are added with the project's standard `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` dance so the migration is idempotent (safe to re-run against an already-migrated DB). The whole thing is wrapped in `BEGIN`/`COMMIT` so it's all-or-nothing. Note what's *not* here: no new table for "delivery fees per order," because (see decisions) we don't have per-order fee data to put in one.

### Backend

- **`src/services/channelMarginService.ts`** (new) — The heart of the sprint. Two exported functions split along the Functional-Core/Imperative-Shell line. `analyzeChannelMargins` (impure shell) does the I/O: fetches menu items, the last-30-day orders, and the order_items for those orders, then hands everything to the pure core. `buildChannelMarginAnalysis` (pure core, exported solely so tests can hit it without a DB) does *all* the math — channel split, cost-known filtering, per-item aggregation, commission, proportional flat-fee allocation, margin percentages, the biggest-gap item, and channel-level summaries. Every monetary value in and out is integer cents. A small `ChannelMarginError` class lets the route map any Supabase failure to a stable 500 without leaking internals.
- **`src/services/__tests__/channelMarginService.test.ts`** (new) — 20-ish unit tests covering only the pure core (the shell has no logic worth testing). They pin down the things that are easy to get subtly wrong: floor-based commission, proportional flat-fee allocation with the remainder dropped, `cost_cents === 0` and `=== null` both excluded, single-channel items getting a `null` gap, and the biggest-gap calculation with a worked example that includes a *negative* delivery margin (item sold below cost after commission). The tests double as executable documentation of the money rules.
- **`src/routes/analytics.ts`** (modified — two new routes at the bottom)
  - `GET /api/analytics/channel-margins` — Thin route. Auth → look up the restaurant by `user_id = req.user.sub` (this is also where it pulls the two new commission columns) → pass them to `analyzeChannelMargins` → return `{ data, error }`. No math in the route.
  - `PATCH /api/analytics/delivery-economics` — Updates the commission/flat-fee settings. Accepts a partial body (at least one of the two fields), validates each with `Number.isInteger` + bounds, **rejects any unknown field** (mass-assignment protection — more on this in decisions), resolves the restaurant id from the token (never trusts a client id), and returns the updated values. The lone `console.error` here logs only `uErr.message`, not the payload, in keeping with the Sprint-N log-scrubbing rule.

### Frontend

- **`src/pages/ChannelMargins.tsx`** (new) — The whole page in one file: a `SettingsPanel` (commission % and flat-fee $ inputs with client-side validation that mirrors the server bounds), four summary cards (in-house net margin, delivery net margin, delivery tax paid, biggest-gap item), a Recharts grouped bar chart, a sortable per-item table, and a "Missing Cost" table. Handles loading, error, and empty states explicitly. Money is formatted from cents only at the leaf (`fmt`, `fmtK`); nothing upstream ever sees a float dollar amount.
- **`src/App.tsx`** (modified) — Imports `ChannelMargins` and mounts it at `/channel-margins` inside the `AppLayout` shell.
- **`src/components/Sidebar.tsx`** (modified) — Adds a "Channel Margins" nav item pointing at `/channel-margins` with the new `channels` icon.
- **`src/components/Icons.tsx`** (modified) — Adds a `channels` icon (the bar-pair glyph) to the `IconName` union and the `PATHS` map.

---

## Key technical decisions

### A configurable commission rate, not real per-order DoorDash fees
**Context.** The "true" delivery margin would subtract the *actual* fee DoorDash charged on each individual order. DoorDash's own reports have that number.
**Decision.** Model the delivery tax as a per-restaurant `commission_bps` + `flat_fee_cents` that the owner configures, and apply it uniformly to delivery revenue.
**Why.** The DoorDash normalizers from Sprint J discard everything except order totals — per-order fee data is simply *not ingested*, so there's nothing in the database to sum. We could have built a whole fee-ingestion pipeline first, but that's a sprint of its own for a feature that's directionally correct with a single configurable rate. A 20%-ish commission is the dominant term; the owner knows their own rate. The honest framing on the page is "true margin after commission," not "exact reconciliation of DoorDash's invoice." When per-order fees get ingested later, this service's interface (`commissionBps`, `flatFeeCents`) is the seam where real per-order data would slot in.

### `cost_cents === 0` is treated identically to `null` — both mean "cost unknown"
**Context.** DoorDash-ingested catalog items land with `cost_cents: 0` because the delivery platform reports no cost data. If we took that literally, every such item would show a 100% margin — gross equals net when cost is zero — which is the most misleading possible number on a *margin* page.
**Decision.** In the pure core, `item.cost_cents == null || item.cost_cents === 0` → the item is cost-unknown: excluded from all margin math and pushed into `missingCostItems` instead.
**Why.** A fake 100% margin is worse than no number, because it's a *confident* lie that would steer the owner to over-promote a money-loser. This extends the Sprint H/I `cost_known` discipline ("unknown cost ≠ $0") to a place where the unknown sneaks in as a literal zero rather than a null. The cost is `> 0` everywhere downstream of the filter, which is why the food-cost line can safely cast `menuItem.cost_cents as number`.

### Integer-cents math everywhere, with floor and a deliberately dropped remainder
**Context.** Commission is a percentage of revenue; a flat fee has to be split across many items. Both invite fractional cents, and the obvious move (floats) is exactly the move the project forbids.
**Decision.** Commission per item = `floor(gross_cents × bps / 10000)`. The total flat-fee burden = `flat_fee_cents × delivery_order_count`, allocated to each delivery item as `floor(totalBurden × itemGross / totalDeliveryGross)`. Whatever cents are left over after flooring every item (at most N−1 cents for N items) are **dropped on the floor**, not stuffed into an arbitrary item.
**Why.** IEEE-754 floats aren't associative — sum enough small fractional dollars and the total drifts — so all arithmetic stays in integer cents (see Sprint A's money rule). Flooring rather than rounding means we never *overstate* the tax (we err toward a slightly rosier delivery margin, never a falsely punishing one). And dropping the sub-cent remainder rather than assigning it to "the first item" keeps the output deterministic and reproducible: the same inputs always produce byte-identical numbers, which is what makes the unit tests possible. The summary's `delivery_tax_cents` reports the *actually allocated* total (e.g. 99¢ when the theoretical burden was 100¢), so the page never claims a tax it didn't distribute.

### Two-hop tenant scoping because `order_items` has no `restaurant_id`
**Context.** The schema puts `restaurant_id` on `orders` but not on `order_items` (order items only carry `order_id`). The usual one-liner `WHERE restaurant_id = ?` can't be applied directly to the table we need.
**Decision.** Fetch the restaurant's orders first (those *are* scoped by `restaurant_id`), collect their ids, then fetch `order_items` filtered by `.in('order_id', theseIds)`.
**Why.** Tenant safety falls out of the data flow rather than a WHERE clause: a tenant's order ids are never visible to another tenant's request, so there is no id you could pass to the second query that would reach another restaurant's items. It's the same trust boundary the whole app relies on (RLS is bypassed at the backend with the service-role key — tenant safety is enforced in code), just expressed through a join-by-fetch instead of a column filter. **Subtle constraint:** PostgREST (the auto-generated REST layer Supabase puts in front of Postgres) encodes every id from `.in()` into the URL query string. UUIDs are 36 chars each; a few thousand orders would blow past the ~8 KB URL limit and the query would silently fail. So the order ids are chunked 500 at a time and the results concatenated — `IN_CHUNK_SIZE = 500` keeps each request well under the limit.

### Strict PATCH validation, including unknown-field rejection
**Context.** `PATCH /delivery-economics` writes directly to a `restaurants` row. The naive version takes `req.body` and updates whatever keys it contains.
**Decision.** Validate each known field with `Number.isInteger` + explicit bounds (0–5000 bps, 0–2000 cents), require at least one field, and **reject the request if `req.body` contains any key that isn't one of the two expected fields**.
**Why.** The unknown-field rejection is mass-assignment protection. Without it, a crafted body like `{ doordash_commission_bps: 2000, user_id: "<someone else's uuid>" }` is the kind of thing that, paired with a careless `update(req.body)`, reassigns ownership of the restaurant. We build the update object from only the validated fields anyway, but rejecting unknown keys outright fails loudly instead of silently ignoring them — it tells an honest client they sent something wrong, and it denies a malicious client the chance to probe what fields exist. The bounds also mirror the DB CHECK constraints exactly, so a value that passes the route can never be rejected by Postgres (validation in two places, but the same numbers, on purpose).

### QA finds, fixed before ship: a React cleanup leak and a clipped chart axis
**The refetch cleanup leak.** The first cut put the data fetch inside a `useCallback` that *returned a cleanup function* — but a `useCallback` isn't a `useEffect`; nothing ever calls the thing it returns. So after saving settings, the post-save refetch had no real cancellation: if the user navigated away mid-refetch, the resolved promise would call `setData` on an unmounted component (the classic "can't update state on an unmounted component" leak). **Fix:** the cleanup logic lives entirely in the `useEffect` that owns the fetch (it sets a `cancelled` flag and calls `controller.abort()` in its returned cleanup). Saving settings just bumps a `refetchKey` counter, which is in the effect's dependency array, so a save *re-runs the effect* — and re-running the effect means the previous run's cleanup fires first, cancelling any in-flight request properly. One source of truth for cancellation, owned by the effect, not scattered into a callback that can't cancel anything.
**The clipped Y-axis.** Delivery margins can go *negative* (an item sold below cost once commission is taken). The chart's `YAxis` was hard-coded to `domain={[0, 100]}`, so any negative bar was clipped flat at zero — the single most important signal on the page (the money-losers) was invisible. **Fix:** a function lower bound, `domain={[(dataMin) => Math.min(0, dataMin), 100]}`. When all margins are positive the axis still starts at 0 (clean baseline); the moment any margin goes negative the axis drops to include it. The upper bound stays 100 because margin percent can't exceed 100.

---

## Patterns and concepts you used

- **Functional Core, Imperative Shell** — `buildChannelMarginAnalysis` is pure: no DB, no clock, no randomness, total function of its arguments. `analyzeChannelMargins` is the thin impure shell that feeds it. This is the same split as `forecastService` in Sprint P, and it's why the test file can exercise every money rule with hand-built arrays and zero mocking. The lesson worth internalizing: push all the logic into a function with no I/O, and testing stops being hard.
- **Two-hop / fetch-then-filter tenant isolation** — when the table you need isn't scoped, scope a parent table first and let the child query inherit safety from the ids you already trust. Generalizes to any "child table has no tenant column" situation.
- **Chunking around a transport limit** — `.in()` with thousands of ids isn't a logic problem, it's a URL-length problem in PostgREST's HTTP layer. Splitting into 500-id batches is the same idea as paginating any request that would otherwise exceed a transport ceiling.
- **Basis points for rates** — storing the commission as an integer bps (2000) instead of a float percent (0.20) keeps the rate itself in integer-land, consistent with the cents-everywhere rule. The conversion to a percent happens only for display, at the leaf, same as money.
- **Floor with intentional remainder loss** — a deterministic allocation strategy. The alternative (largest-remainder / "give the leftover cent to the biggest item") is more *fair* but less *predictable*; for an analytics readout, reproducibility beats penny-perfect fairness. Worth knowing the tradeoff exists.
- **Mass-assignment protection via allow-listing** — never `update(req.body)`; build the update object from a known set of validated fields and reject anything outside it. The unknown-field rejection is the explicit, loud version of the same idea.
- **Effect-owned cancellation** — a `refetchKey` counter in the dependency array is the idiomatic way to *re-trigger* an effect while keeping that effect the sole owner of setup and teardown. Don't put cancellation anywhere a `useEffect` cleanup can't reach.

---

## What you should be able to explain in an interview

**Q: Your delivery margins subtract a "delivery tax." Why is it a configured rate instead of DoorDash's real per-order fees?**
Because we don't ingest the real fees. The DoorDash normalizers from an earlier sprint keep only order totals — per-order commission isn't in our database, so there's nothing to sum. Building a whole fee-ingestion pipeline is its own sprint, and for an MVP a single configurable commission rate plus a flat fee per order captures the dominant term: commission is ~20% and the owner knows their own deal. So I store `commission_bps` and `flat_fee_cents` per restaurant and apply them uniformly to delivery revenue. The page is labeled "true margin after commission," which is honest about what it is. The service takes those two values as arguments, so if we ingest real per-order fees later, that's the exact seam where they'd plug in — the math downstream doesn't change.

**Q: DoorDash items come in with a zero cost. How do you keep that from producing fake 100% margins?**
I treat `cost_cents === 0` exactly like `null` — both mean "cost unknown." Those items get excluded from all margin math and shown in a separate "Missing Cost" list. The reason zero is dangerous specifically on a margin page: if cost is zero, net equals gross, so the item shows 100% margin — a confident, flattering lie that would push the owner to over-promote a money-loser. A missing number is safer than a wrong one. It's the same "unknown cost is not $0" rule the costing features established, applied to the case where the unknown shows up as a literal zero instead of a null.

**Q: Walk me through how you allocate the flat fee across items, and why a cent goes missing.**
The total flat-fee burden is the per-order fee times the number of delivery orders. I split that across delivery items proportionally by each item's share of delivery gross revenue — `floor(totalBurden × itemGross / totalDeliveryGross)` for each. Because I floor every item's share, the pieces can sum to slightly less than the total — up to N−1 cents short for N items. I deliberately drop that remainder rather than assign it to some arbitrary item. The reason is determinism: same inputs, same output, byte for byte, which is what lets me unit-test the money math. And the summary reports the actually-allocated tax, not the theoretical total, so the page never claims a cent it didn't distribute. Flooring also means I never overstate the tax — I err toward a slightly rosier delivery margin, never a falsely worse one.

**Q: `order_items` has no `restaurant_id`. How do you stop one tenant from reading another's order items?**
I scope a parent table instead of the child. First I fetch the restaurant's orders — those *are* scoped by `restaurant_id` — and collect their ids. Then I fetch `order_items` filtered by `IN (those order ids)`. A tenant's order ids are never visible to another tenant's request, so there's no id I could pass into the second query that would reach another restaurant's items. Safety comes from the data flow rather than a WHERE clause on the child table. One wrinkle: Supabase's REST layer encodes every id from an `.in()` into the URL, and UUIDs are long, so with thousands of orders I'd blow the URL-length limit. So I chunk the ids 500 at a time and concatenate the results.

**Q: Your settings PATCH rejects unknown fields. Why bother if you only read the two you care about?**
It's mass-assignment protection. The route writes to a `restaurants` row. If I were sloppy and did `update(req.body)`, a body with an extra key like `user_id` could reassign the restaurant to someone else. I build the update object from only the two validated fields, so I'm safe on that front — but rejecting unknown keys outright is the loud version: it fails the request instead of silently ignoring the extra field, which tells an honest client they sent something wrong and denies a malicious one the chance to probe what fields exist. I also validate the two fields with `Number.isInteger` plus the same 0–5000 / 0–2000 bounds the database CHECK constraints enforce, so anything that passes the route can't be bounced by Postgres.

**Q: You hit a React state-update-on-unmounted-component leak. What caused it and how'd you fix it?**
The original code put the fetch in a `useCallback` that returned a cleanup function — but a `useCallback` doesn't run cleanups; only `useEffect` does. So after saving settings, the refetch had no real cancellation, and if you navigated away mid-refetch the promise resolved and called `setState` on an unmounted component. The fix was to give the fetch `useEffect` sole ownership of cancellation — it sets a `cancelled` flag and aborts an `AbortController` in its cleanup. Saving settings just increments a `refetchKey` that's in the effect's dependency array, so a save re-runs the effect, and re-running the effect fires the previous run's cleanup first. One owner for setup and teardown, instead of cancellation logic stranded in a callback that can never run it.

---

## What to look up if you want to go deeper

- **IEEE-754 and why money isn't a float** — the classic "What Every Computer Scientist Should Know About Floating-Point Arithmetic" (Goldberg, 1991). The non-associativity of float addition is the concrete reason this whole codebase stores cents as integers.
- **Largest-remainder / apportionment methods** — the flat-fee allocation drops its remainder; the "fair" alternatives are the same algorithms used to apportion legislative seats (Hamilton/largest-remainder method, the Alabama paradox). Worth reading to understand exactly what fairness you're trading for determinism.
- **Mass assignment** — the OWASP "Mass Assignment" cheat sheet, and the original Rails GitHub mass-assignment incident (2012) that made the term famous. The unknown-field rejection in the PATCH route is the textbook mitigation.
- **PostgREST and the `.in()` URL limit** — the PostgREST docs on horizontal filtering, plus any write-up on practical HTTP URL-length ceilings (~8 KB on most servers). Explains why batching at 500 ids exists.
- **React effect cleanup and `AbortController`** — the React docs "Synchronizing with Effects" (the section on race conditions and the `ignore`/`cancelled` flag), and MDN on `AbortController`. The `refetchKey`-in-deps pattern is the idiomatic re-trigger.
- **Functional Core, Imperative Shell** — Gary Bernhardt's "Boundaries" talk (2012). `buildChannelMarginAnalysis` vs `analyzeChannelMargins` is exactly this.
- **Row-Level Security in Postgres/Supabase** — the Supabase RLS docs. We bypass RLS with the service-role key and enforce tenancy in code (the two-hop fetch is part of that); understanding RLS shows you what the DB-level alternative would look like once tenant count justifies it.

---

## Things you punted (named technical debt)

- **Commission is a single flat rate, not DoorDash's real fee schedule** — real DoorDash commission varies by plan tier, promotion, and sometimes per-order. Until per-order fees are ingested, every delivery item pays the same configured rate. The `analyzeChannelMargins(restaurantId, commissionBps, flatFeeCents)` signature is the seam where real per-order data would replace the flat rate.
- **Per-order fee data is still discarded at ingestion** — the DoorDash normalizers keep only totals. Capturing the fee breakdown DoorDash sends is a prerequisite for ever making this page an exact reconciliation rather than an estimate. Name it: "DoorDash fee-line ingestion."
- **30-day window is hard-coded** — `analyzeChannelMargins` always looks back exactly 30 days. No way to ask for last quarter or a custom range. A `windowDays` parameter threaded from a query string is the obvious next step.
- **No caching** — `GET /channel-margins` re-fetches orders + order_items and recomputes on every page load. Cheap enough today, but it's the same recompute-on-read pattern that the Sprint P advisor cached. If this page gets hot, the pre-aggregation or a short-TTL cache is the move.
- **`IN_HOUSE_SOURCES` is a hard-coded set** — `{'square','toast','manual'}` lives in the service. A new in-house POS source means editing this constant, and `toast` is listed even though Square is the live integration. Unknown sources (e.g. `grubhub`) are silently dropped from both channels, which is correct-but-quiet; a future "other delivery" channel would need real handling.
- **Client and server validation bounds are duplicated by hand** — the page's `MAX_COMMISSION_BPS`/`MAX_FLAT_FEE_CENTS`, the route's checks, and the DB CHECK constraints all encode 5000/2000 independently. Three places to update if a bound ever changes. A shared constants module (or generating one from the other) would remove the drift risk.
- **Biggest-gap item only considers items sold on both channels** — an item sold heavily on delivery at a terrible margin but never in-house won't surface as the "biggest gap" because it has no in-house margin to compare against. That's defensible (a gap needs two sides) but it means a delivery-only money-loser hides. Worth a separate "worst delivery margin" callout later.
