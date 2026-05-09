# Week 5 — Alerts Hardening + Browser Push Notifications (Sprint F)

> Teaching summary. The code from Week 4 worked; this sprint made it *safe to leave alone*. Read it twice — once now, once before any interview where "production readiness" comes up.

---

## Sprint goal in one sentence

Take the alerts engine from "it works on my machine" to "I would let it run unsupervised for a month": tighten the schema with a CHECK constraint matching the type system, add a focused index for the read path, fix a race condition in the optimistic UI, and add an opt-in browser notification so an operator who isn't staring at the dashboard still finds out when something fires.

## Why this sprint matters at this stage of the product

After Week 4 the system *generates* alerts correctly. What it didn't do was *defend itself* against the kinds of failures that show up only in production: a typo in a future code path inserting `'no_sale'` instead of `'no_sales'` and the frontend silently rendering a broken badge; a user double-clicking "Mark all read" while a single "Mark read" was in flight and watching the row resurrect. Operational maturity is the work between "the happy path works" and "the unhappy paths fail loudly." This sprint is mostly that work.

It also adds the cheapest possible push channel — the browser's native `Notification` API — so the dashboard doesn't have to be open for an alert to be useful. No service worker, no APNs, no FCM. Just enough to validate that operators *want* push before paying the integration cost of real push.

---

## File-by-file: what it is, why it exists

### Backend — schema hardening

**`restaurantiq-backend/migrations/011_alerts_type_check.sql`** — Adds a `CHECK` constraint pinning `alerts.type` to the five values the engine is allowed to emit: `no_sales`, `trending_down`, `new_top_performer`, `unusual_spike`, `traffic_drop`. The column was originally added as plain `TEXT` with no constraint — meaning a typo, a stale code path, or a misconfigured caller could insert `'no_sale'` and the frontend's badge map would silently return `undefined`, the row would render as a blank pill, and nobody would notice until a user complained.

The migration does three things in a single transaction:
1. Defensively `UPDATE`s any rows whose type is outside the allowed list to `'no_sales'`. Without this step, the `ALTER` would fail on dirty sandbox data.
2. `DROP CONSTRAINT IF EXISTS alerts_type_check` — this is the line that took a debugging session to land on (see "What broke during QA").
3. Adds the new five-value constraint.

Wrapped in `BEGIN ... COMMIT` so a failure at any step rolls back cleanly.

**`restaurantiq-backend/migrations/012_alerts_list_index.sql`** — Adds a two-column index `alerts_restaurant_created_idx (restaurant_id, created_at DESC)` tuned specifically for the `GET /api/alerts` list query. The reason this is a *new* index, not a reuse of Week 4's `(restaurant_id, type, menu_item_id, created_at DESC)` composite, is the most subtle topic in this sprint — see "Patterns and concepts" below.

### Backend — alerts engine

**`restaurantiq-backend/src/services/alertsService.ts`** — The engine's `AlertType` union was widened from three values to five: `unusual_spike` and `traffic_drop` are now first-class types in the system, even though `evaluateAlerts()` doesn't yet implement rules for them. They appear in:
- The TypeScript `AlertType` union.
- The `fetchRecentAlertKeys` `.in('type', [...])` filter (so when those rules ship, dedup just works).
- The CHECK constraint (migration 011).
- The frontend's `TYPE_BADGE` map (purple for spike, orange for traffic drop).

This is **deliberate dead code**. Wiring all five layers now means the rule author next sprint writes one function, not five edits across schema, types, and UI. Stub-now / fill-later is a valid pattern when the cost of stubbing is low and the integration surface is wide.

### Frontend — alerts UI

**`restaurantiq-frontend/src/components/AlertsBanner.tsx`** — Two responsibilities now:
1. The Week 4 banner UI (count + "View" / "Dismiss all" with optimistic dismissal + rollback on failure).
2. **New:** browser push notifications via the native `Notification` API. After fetching unread count, `maybeNotify(count)` checks `Notification.permission`. If `default`, it requests permission during a user-driven page load (the `useEffect` is triggered by `session` becoming available, which itself is downstream of the user's sign-in click — modern browsers require user activation for permission prompts). If `granted`, it fires a notification. If `denied`, it silently does nothing.

Dedup is handled with `sessionStorage.getItem('riq_alerts_notified')` — once per tab session. Closing the tab and reopening produces a new notification; reloading the page does not. `localStorage` would have made it once-per-browser-forever, which is the wrong tradeoff: an operator who closed their browser yesterday should be re-notified about today's unread alerts.

**`restaurantiq-frontend/src/pages/AlertsPage.tsx`** — The `handleMarkAllRead` handler was reordered to fix a race. The Week 4 version called `setIsMarkingAll(true)` *after* the optimistic `setPageState`, leaving a one-render window where:

1. The optimistic state update marks every alert as read locally.
2. React schedules a re-render.
3. Before `setIsMarkingAll(true)` runs, a fast click on a per-item "Mark read" button fires `handleMarkRead`.
4. `handleMarkRead`'s `isMarkingAll` guard sees `false` (not yet set) and proceeds.
5. Both POSTs land at the server. If the server hits an error on the per-item call, the rollback restores `priorState`, which is now stale relative to `read-all`'s success.

Two changes fixed it:
- `setIsMarkingAll(true)` moved to the top of `handleMarkAllRead`, before the optimistic state mutation.
- `handleMarkRead` got an `isMarkingAll` guard added to its early-return check.

---

## Patterns and concepts you used

### CHECK constraints vs application-level validation

You have a TypeScript union: `AlertType = 'no_sales' | 'trending_down' | 'new_top_performer' | 'unusual_spike' | 'traffic_drop'`. Why also enforce it in the database? Three reasons:

1. **TypeScript only protects the code paths the compiler sees.** A migration script written in raw SQL, a one-off `psql` insert, or a future service in a different language all bypass the type system entirely. The DB is the only layer every writer must go through.
2. **`as` casts and `unknown` escape hatches happen.** The codebase already has `as unknown as DailySummaryRow[]`. Type assertions silence the compiler but don't change runtime behavior.
3. **The cost of a CHECK is microscopic.** Postgres evaluates an `IN (...)` predicate in nanoseconds per row.

Conversely, why not rely on the DB constraint alone? Because a 500 from the database is a *terrible* user experience compared to a TypeScript error at compile time or a 400 with a clear message. The two layers serve different audiences: TS catches the developer, the DB catches everyone else.

The general principle: **defense in depth**. The same data invariant is enforced at the TS layer, the API layer (where applicable), and the schema. Each layer assumes the previous one might fail.

### PostgreSQL index selection — why two indexes instead of one

Week 4 created `alerts_restaurant_type_item_created_idx` on `(restaurant_id, type, menu_item_id, created_at DESC)`. Week 5 added `alerts_restaurant_created_idx` on `(restaurant_id, created_at DESC)`. Why not just reuse the four-column index?

A B-tree index in Postgres is sorted lexicographically by its column tuple. The planner can use a **leading prefix** of the index for free — an index on `(a, b, c, d)` can serve queries that filter on `a`, on `(a, b)`, on `(a, b, c)`, or on `(a, b, c, d)`. It cannot efficiently serve a query that filters on `a` and orders by `d`, because between any two values of `a`, the rows are sorted first by `b`, then by `c`, then by `d` — so to read them in `d` order you'd have to scan all the `b/c` interleavings and re-sort.

The list query is `WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 50`. Against the four-column index, Postgres would scan all rows for the restaurant and walk every `(type, menu_item_id)` interleaving before reaching `created_at` order. The two-column index `(restaurant_id, created_at DESC)` makes the list a tight range scan: find the leaf for `restaurant_id`, walk backwards by `created_at` for 50 rows, done.

The dedup query (`WHERE restaurant_id = ? AND type IN (...) AND created_at >= ?`) still uses the four-column index because the leading prefix `(restaurant_id, type)` matches. Both indexes earn their keep.

Tradeoff: every index slows writes (each `INSERT` updates every index) and consumes disk. For an alerts table that writes a few rows per sync and reads on every dashboard load, the read-favoring tradeoff is correct.

### Optimistic UI updates and rollback

The pattern:
1. Save prior state in a local variable (closure-captured before any state mutations).
2. Set the new state synchronously.
3. Fire the network request.
4. On success, do nothing — the optimistic state was already correct.
5. On failure, restore from saved prior state and surface an error.

What makes rollback tricky:
- **Stale closure capture.** `priorState` is the state at the time the handler was invoked. If three rapid clicks pile up, each handler captures its own snapshot — and rolling back to "the state when this click started" may not match the current shape of the list.
- **React state batching.** Multiple `setState` calls inside an event handler are batched into a single render. If you call `setPageState(newState)` and then immediately read `pageState`, you get the *old* value because the assignment to `pageState` happens after the handler returns. This is why `priorState = pageState` at the top of the handler reads the correct pre-mutation snapshot.

### Race condition prevention with in-flight flags

`isMarkingAll` is a **mutex flag** at the React level. It guarantees that while one `handleMarkAllRead` is in flight, no `handleMarkRead` can fire. The order of operations is what makes the guarantee work:

```ts
setIsMarkingAll(true);          // set flag FIRST
// ...optimistic state mutation...
await fetch('/api/alerts/read-all', ...);
```

If you reverse those two lines, there's a render between the optimistic mutation and the flag being set, and any click handler that fires in that window sees `isMarkingAll === false`. This is the same class of bug as initializing a lock *after* publishing a reference to the object it protects.

The deeper insight: **state in React is async (batched render commits) but JS execution within an event handler is synchronous.** The flag is read synchronously from the closure of the next-rendered component, so as long as the assignment happens first in source order, every subsequently-rendered handler sees `true`.

### Browser Notification API permission lifecycle

The states are `'default'` (unasked), `'granted'`, `'denied'`. The lifecycle:

1. `Notification.permission` starts at `'default'`.
2. `Notification.requestPermission()` shows the browser's native prompt — but **only if the call originates from a user-activation context** (a click, a form submit, etc.). Calls from a raw `setTimeout` or unconstrained `useEffect` will silently fail in modern browsers.
3. The user picks `'granted'` or `'denied'`. The choice is persistent per-origin.
4. Once `'denied'`, you cannot prompt again from JavaScript — the user has to reset it in browser settings.

Implications baked into `AlertsBanner.tsx`:
- `requestPermission()` is called inside the `useEffect` that depends on `session` — immediately after sign-in, which was itself a click. That's typically activation-fresh enough.
- `'denied'` is handled silently (no error UI, no nag). Once a user has said no, asking again is hostile.

**Why `sessionStorage` and not `localStorage` for dedup:** `localStorage` would suppress notifications forever per origin — once notified, never again. `sessionStorage` is per-tab and clears when the tab closes. Operators want one notification per work session, not one per browser install.

**Why no service worker:** A service worker plus the Push API delivers notifications when the tab is closed. It requires HTTPS, a registered SW script, server-side push subscriptions, VAPID keys, and integration with FCM or APNs — roughly half a sprint of work. Native `Notification` ships in 30 lines and validates whether operators want push at all. When push-while-closed becomes the bottleneck, SW + Push API is the upgrade path.

### Idempotent migrations

Idempotency = running it twice produces the same end state as running it once. The standard tool is `IF NOT EXISTS`:

```sql
CREATE INDEX IF NOT EXISTS alerts_restaurant_created_idx ON alerts (...);
```

Migration 012 uses this directly and is correct.

Migration 011's first draft tried the same pattern for the constraint:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_type_check') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (...);
  END IF;
END $$;
```

The bug: a constraint named `alerts_type_check` *did* exist — left over from an earlier migration with only three values. The guard saw "the constraint exists" and skipped the `ADD`, leaving the old, narrower constraint in place. This is the limitation of `IF NOT EXISTS`: it only checks for the *name*, not for whether the existing thing is *correct*.

The fix: `DROP CONSTRAINT IF EXISTS alerts_type_check; ALTER TABLE ADD CONSTRAINT ...`. The pattern: **drop-then-create is more robust than create-if-missing for things that can change shape**.

---

## What broke during QA and why

### Bug 1: The "constraint already exists" trap

**Symptom:** After running migration 011, inserting `unusual_spike` was still rejected by the constraint check.

**Root cause:** The `IF NOT EXISTS` guard in the `DO` block found the three-value constraint already in place and skipped the `ADD CONSTRAINT` entirely. The migration appeared to succeed but changed nothing.

**Lesson:** "exists" and "is correct" are different predicates. `IF NOT EXISTS` answers the first; you wanted the second. Drop-then-add forces the constraint into its current shape regardless of prior state. Every time you write a "skip if already done" guard, ask: *what if the thing was done wrong?*

### Bug 2: The mark-all race in AlertsPage

**Symptom:** Rapid clicking — "Mark all read," then a per-item "Mark read" before the first request returned — could result in the per-item alert resurrecting after the bulk request completed.

**Root cause:** `setIsMarkingAll(true)` was called *after* the optimistic `setPageState`. Between those two statements, a re-render is possible and a per-item click handler fires with `isMarkingAll === false`, slipping past the guard.

**Fix:** Reordered so the flag is set first; added an `isMarkingAll` guard to `handleMarkRead` so the protection is symmetric.

**Lesson:** when a flag guards a critical section, the *first* line of the critical section sets the flag. This is a direct analogue of "acquire the lock before touching the shared state" in any multithreaded language.

### Pre-existing bug flagged but not fixed

**Money formatting in the backend.** `alertsService.ts` builds messages like `$${(currentRevenue / 100).toFixed(2)}` and persists them to the DB. The codebase's invariant is "money is integer cents from the DB to the API to the frontend; only the frontend formats." Not fixed this sprint because it's pre-existing, not introduced by these changes, and the fix crosses backend and frontend and warrants its own PR. Knowing-but-not-fixing is fine; not-knowing is the problem.

---

## Interview talking points

**"You added a CHECK constraint on a column whose type is already enforced in TypeScript. Why?"**
The TypeScript union only protects code paths the compiler sees. The DB is the one layer every writer must go through — a future service in another language, a one-off psql insert, or a code path that uses an `as` cast all bypass the TS check. The CHECK is essentially free at runtime and turns a class of silent bugs into loud ones. They're complementary, not redundant.

**"Why a separate index for the list query? You already have a four-column composite index."**
The four-column index is `(restaurant_id, type, menu_item_id, created_at DESC)`. A B-tree index can serve any leading prefix, but the list query — `WHERE restaurant_id = ? ORDER BY created_at DESC` — skips `type` and `menu_item_id`. To read rows in `created_at` order from the four-column index, Postgres would have to scan all the type/item interleavings. The two-column index `(restaurant_id, created_at DESC)` makes the list a tight range scan. Both indexes earn their keep for different access patterns.

**"Walk me through the optimistic UI race you fixed."**
The `isMarkingAll` flag was set *after* the optimistic state mutation. Between those statements, a re-render is possible, so a per-item click could fire and find the flag still false. Both requests would hit the server, and the rollback paths could restore stale state. The fix was to set the flag first, before the optimistic mutation, and to add the guard to the per-item handler too — symmetric protection. Same rule as acquiring a lock before touching shared state.

**"Why `sessionStorage` and not `localStorage` for notification dedup?"**
`localStorage` would suppress notifications forever per origin. `sessionStorage` is per-tab and clears when the tab closes, so the operator gets one notification per work session. Closing the browser yesterday and reopening today produces a new notification.

**"Why didn't you ship a service worker for real push notifications?"**
A service worker plus the Push API is the right answer for delivery while the tab is closed, but it requires HTTPS, a registered SW script, server-side push subscriptions, VAPID keys, and FCM/APNs integration — roughly half a sprint of work. Native `Notification` ships in 30 lines and validates whether operators want push at all. When usage shows that push-while-closed is the gap, that's the trigger to upgrade.

**"You added two alert types but didn't implement the rules. Isn't that dead code?"**
Deliberate dead code. The integration surface is wide: the TypeScript union, the dedup `IN` list, the CHECK constraint, and the frontend badge map. Wiring all of them now means the rule author next sprint writes one function in `evaluateAlerts` and ships. The cost of stubbing is low; the benefit is that the next sprint stays small and reviewable.

**"Tell me about a migration that bit you and what you learned."**
Migration 011 added a CHECK constraint to widen allowed values from three to five. First version used `IF NOT EXISTS` inside a `DO` block. The bug: the constraint already existed by name, from an earlier migration, but with only three values. The guard saw the name and skipped, so the schema kept the narrow version. Lesson: `IF NOT EXISTS` answers a question about existence, not correctness. For things that can change shape, drop-then-add is more robust than create-if-missing.

---

## What to look up if you want to go deeper

- **PostgreSQL CHECK constraints and `pg_constraint`** — the system catalog; understanding it is what lets you write robust idempotent migrations.
- **"Use The Index, Luke" by Markus Winand** — chapters on multi-column indexes and the leading-column rule; the single best free resource for index strategy.
- **MDN: Notification API and the Permissions model** — short, but the user-activation rule for `requestPermission()` is the kind of thing you'll otherwise hit as a production bug.
- **MDN: Service Worker API + Push API** — read once so you understand what you didn't ship and why it's the right next step if push-while-closed becomes the requirement.
- **"Designing Data-Intensive Applications" ch. 7 (Transactions)** — the section on race conditions and isolation levels generalizes the `isMarkingAll` bug to a whole class of write-skew scenarios.

---

## Things punted (track by name)

- **Money formatting in the backend.** `alertsService.ts` formats cents to display strings and persists them. Should move to frontend render time.
- **`unusual_spike` rule unimplemented.** Likely shape: `currentRevenue > 1.5 * priorRevenue && priorRevenue > 1000`.
- **`traffic_drop` rule unimplemented.** Likely shape: compare current-week order count to prior-week, fire if `current < 0.7 * prior` and `prior > 50` orders.
- **No real push delivery.** Native `Notification` only fires while a tab is open. Upgrade path: service worker + Push API + VAPID.
- **`sessionStorage` flag is per-tab.** Two tabs open simultaneously = two notifications. Acceptable for now.
- **No "reset notification permission" affordance.** Once denied, browsers don't let JS reopen the prompt. A settings-page link explaining how to reset would be friendlier.
