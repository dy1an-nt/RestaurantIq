# Week 4 — AI Insights Dashboard + Deterministic Alerts Engine

> Teaching summary. Read it once now to lock in what you built; read it again before any interview where you might describe this project.

---

## Sprint goal in one sentence

Turn the existing data backbone into something a restaurant operator would actually open the app to see: an LLM-backed "Insights" page on the frontend, and a deterministic, explainable alerts engine that fires automatically after every Square sync.

## What shipped, in plain English

1. **The Insights page is real.** It calls the existing `/api/insights` endpoint, handles loading / error / empty / data as four distinct, mutually exclusive states, and renders 7 categories of recommendation with color-coded cards.
2. **There's an alerts engine.** After every sync, the backend looks at the last 14 days of per-item data, splits it into two 7-day windows, and fires three kinds of alerts: an item went silent (`no_sales`), an item dropped more than 20% week-over-week (`trending_down`), or an item just broke into the top 3 (`new_top_performer`).
3. **Alerts deduplicate at two layers.** A pre-flight in-memory check skips obvious repeats; a unique index on `(restaurant_id, dedup_key)` is the final race-safe guard at the database.
4. **The app surfaces alerts in two places.** An amber banner inside the main layout shows unread count and a "Dismiss all" button; a dedicated `/alerts` page lists every recent alert with optimistic per-item and bulk read controls.
5. **None of the alert logic touches an LLM.** Rules are pure functions of inputs you can read on a whiteboard. Insights are generative; alerts are deterministic. Knowing which problem is which is the point.

---

## File-by-file: what it is, why it exists

### Frontend — Insights

**`restaurantiq-frontend/src/components/InsightsPanel.tsx`** — The full-fat panel component. Owns the fetch lifecycle for `/api/insights`, models its UI state as a discriminated union (`loading | error | empty | data`), and renders a responsive grid of `InsightCard`s. Defines `CATEGORY_STYLES` as a hardcoded `Record<InsightCategory, CategoryStyle>` so Tailwind's JIT compiler can statically discover every class string at build time — dynamically constructed class names like `` `bg-${color}-100` `` get tree-shaken away because the JIT can't see them. *Why this file exists:* the previous `Insights.tsx` was a placeholder; the AI backend had no UI surface.

**`restaurantiq-frontend/src/pages/Insights.tsx`** — Thin route wrapper that just renders `<InsightsPanel />`. The page-level file stays trivial; the component owns all of the logic. *Why split:* keeps page files declarative so they stay readable as routes grow, and makes the panel testable in isolation.

### Frontend — Alerts

**`restaurantiq-frontend/src/components/AlertsBanner.tsx`** — A peripheral piece of UI rendered inside `AppLayout`. Fetches `/api/alerts`, counts unread, renders an amber strip with a count and two actions (`View alerts`, `Dismiss all`). Dismissal is **optimistic** — `setDismissed(true)` fires *before* the network call resolves; the banner disappears immediately and the user never sees the latency. If the request fails, we log and move on rather than re-popping a banner the user just dismissed.

**`restaurantiq-frontend/src/pages/AlertsPage.tsx`** — Full alert list at `/alerts`. Same discriminated-union state machine as `InsightsPanel`. Each `AlertCard` shows a severity-colored left border (`info` blue, `warning` amber, `critical` red), a type badge, a relative timestamp computed in-component (`relativeTime`), and a "Mark read" button when unread. Per-item and bulk read use optimistic state updates: the local copy mutates first, the API call is fire-and-forget after.

### Frontend — wiring

**`restaurantiq-frontend/src/App.tsx`** *(modified)* — Adds the `/alerts` route inside the protected layout and mounts `<AlertsBanner />` once at the top of `AppLayout` so it appears above every authenticated page.

**`restaurantiq-frontend/src/components/Sidebar.tsx`** *(modified)* — One new nav entry pointing at `/alerts`.

### Backend — Alerts engine

**`restaurantiq-backend/migrations/009_alerts_engine.sql`** — Schema growth, not schema rewrite. The original `alerts` table was a stub: `id`, `restaurant_id`, `menu_item_id`, `type`, `is_read`, `created_at`. This migration adds `severity`, `title`, `message`, and `metadata JSONB` so each alert is self-describing, plus a composite index `(restaurant_id, type, menu_item_id, created_at DESC)` that supports both the dedup query and the `GET /api/alerts` list. Wrapped in `BEGIN; ... COMMIT;` and uses `IF NOT EXISTS` so it's idempotent — running it twice is a no-op.

**`restaurantiq-backend/migrations/010_alerts_dedup_key.sql`** — Adds the `dedup_key TEXT NOT NULL` column and a `UNIQUE INDEX` on `(restaurant_id, dedup_key)`. Pattern worth memorizing for adding a NOT NULL column to a non-empty table: add nullable → backfill (`UPDATE alerts SET dedup_key = id::text WHERE dedup_key IS NULL`) → flip to `NOT NULL`. You can't go straight to `NOT NULL` because the existing rows would violate it.

**`restaurantiq-backend/src/services/alertsService.ts`** — The engine. Three responsibilities, kept separate:
- `fetchItemStats(restaurantId)` — I/O. Pulls 14 days of `daily_summaries` joined with `menu_items(name)` in one query, groups by `menu_item_id`, sums into two non-overlapping 7-day windows.
- `evaluateAlerts(items)` — pure. Three rules, each with explicit noise floors. Same inputs always yield same alerts, no I/O, no `Date.now()` inside the rules themselves (the windows were already computed upstream).
- `generateAlerts(restaurantId)` — orchestrator. Runs `Promise.all([fetchItemStats, fetchRecentAlertKeys])`, evaluates rules, stamps `restaurant_id` and `dedup_key` onto each candidate, filters against the in-memory recent set, then `upsert` with `{ onConflict: 'restaurant_id,dedup_key', ignoreDuplicates: true }`. Wrapped in try/catch — alerts never block a sync.

**`restaurantiq-backend/src/routes/alerts.ts`** — Three handlers, all `authMiddleware`-gated:
- `GET /` — lists 50 most recent alerts for the authenticated restaurant.
- `POST /read-all` — marks every unread alert read in one update.
- `POST /:id/read` — fetches the alert, checks `existing.restaurant_id === restaurant.id`, returns 403 on mismatch, then updates. The fetch-then-check is what stops a malicious client from marking another tenant's alerts as read by guessing UUIDs.

**`restaurantiq-backend/src/services/square/ingestSquare.ts`** *(modified)* — One added `await generateAlerts(restaurantId)` after `refreshDailySummaries`. Importantly, the call is awaited but its failure can't propagate because `generateAlerts` swallows its own errors and returns `0`. The sync's success contract is unchanged.

**`restaurantiq-backend/src/server.ts`** *(modified)* — `app.use('/api/alerts', alertsRouter)` registration.

---

## Key technical decisions

### 1. Discriminated union over boolean flags for fetch state

**Context:** The natural first instinct is `useState({ loading: false, error: null, data: null })` — three booleans / nullables that are read independently. This invites bugs where the UI ends up in an impossible state ("loading and error and data all truthy at once") because nothing in the type system stops you from setting them inconsistently.

**Decision:** Model state as a tagged union: `{ status: 'loading' } | { status: 'error', message } | { status: 'empty' } | { status: 'data', insights }`.

**Why:** The compiler refuses to let you read `state.message` unless you've narrowed `state.status === 'error'`. That makes "fields that only exist in some states" *part of the type*, not a runtime convention. The render block becomes four mutually exclusive branches — no `if (loading && !error && data?.length)` ladder, ever.

**Subtle bug we hit:** the early version had `if (!session) return;` inside the `useEffect` and never set state. So if a user landed on Insights without a session (race condition during sign-in), they saw an animated skeleton forever — the loading state was the *initial* state and nothing had any reason to change it. Fix: when `!session`, explicitly set state to `error`. **Lesson: an "always-loading" UI is one of the most common React bugs and almost always means a code path that returns without calling `setState`.**

### 2. Tailwind class strings have to be static literals

The `CATEGORY_STYLES` object holds full class strings like `'bg-blue-100 text-blue-800'`, not `'blue'`. Tailwind's JIT scans your source code at build time and only emits classes it can find as literal substrings. If you write `` `bg-${category}-100` ``, the compiled CSS won't include `bg-blue-100` because the JIT never saw that exact string. **The fix is exactly what the code does:** map every category to a precomposed class string. Ugly, but the alternative is brittle runtime hacks or shipping every Tailwind color in the bundle.

### 3. StrictMode-safe fetching with `cancelled` + `AbortController`

React 18 in StrictMode runs effects twice in development to surface bugs caused by leaked subscriptions. If your `useEffect` kicks off a fetch and naively calls `setState` when it returns, the second effect's response races the first one — and worse, even after the component unmounts, a late response calls `setState` on a dead component.

The pattern in `InsightsPanel`, `AlertsPage`, and `AlertsBanner`:

1. Declare `let cancelled = false` and `const controller = new AbortController()` inside the effect.
2. Pass `signal: controller.signal` to `fetch`.
3. Check `if (cancelled) return;` after every `await`.
4. The cleanup function sets `cancelled = true` and calls `controller.abort()`.

Why both? `AbortController` cancels the network request (saves bandwidth, releases the connection); `cancelled` flag stops `setState` if the response was already in flight when cleanup ran. They are not redundant — they handle different points in the await chain.

**Subtle detail:** `setFetchState({ status: 'loading' })` is called *synchronously* before the IIFE, not inside it. If you put it inside the `(async () => { setFetchState... })()`, the first await in the IIFE could schedule earlier and you'd briefly render whatever the previous render had.

### 4. Two-layer deduplication — in-memory + DB unique index

**Context:** `generateAlerts` runs after every sync. A user clicking "Sync" twice in a row, or two browser tabs syncing in parallel, would otherwise produce duplicate alerts.

**Decision:** First, fetch all alerts of the relevant types from the last 7 days into a `Set<string>` keyed by `${type}|${menu_item_id ?? ''}` and skip any candidate already in the set. Second, define `dedup_key = "${type}|${menu_item_id ?? ''}|${monday-of-current-UTC-week}"` with a unique index, and use `upsert(..., { onConflict: 'restaurant_id,dedup_key', ignoreDuplicates: true })`.

**Why both:** the in-memory check is cheap and avoids hammering the DB with `INSERT ... ON CONFLICT DO NOTHING` calls when we already know they'd no-op. But the in-memory check has a TOCTOU (time-of-check-to-time-of-use) gap: between "I checked the DB at T0" and "I insert at T1," another sync could have inserted the same row. The unique index closes that gap at the DB level — Postgres serializes the conflict and `ignoreDuplicates: true` translates it into `ON CONFLICT DO NOTHING`.

**Why include the week in the dedup key but not in the in-memory set:** the in-memory set's filter by `created_at >= 7 days ago` is equivalent to the week bucket for the active sync — they're filtering the same recent window. But the persistent `dedup_key` needs to encode the week explicitly so next week's run for the same item naturally produces a different key and isn't blocked.

### 5. Integer-only threshold math: `5 * currentRevenue < 4 * priorRevenue`

The trending-down rule is "more than 20% drop." The naive expression is `currentRevenue / priorRevenue < 0.8`. Two problems: division by an integer in JavaScript produces a float, and `0.8` isn't exactly representable in IEEE-754 (it's `0.79999...`). For most inputs you don't notice; on edge values you get inconsistent classifications.

Multiply both sides by `priorRevenue` (positive, so inequality direction holds) and by 5: `5 * currentRevenue < 4 * priorRevenue`. Pure integer arithmetic. Same answer, no float drift, easier to reason about. We only fall back to floats for the *display* string (`Math.floor(((priorRevenue - currentRevenue) / priorRevenue) * 100)`), where a single-pixel rounding error doesn't matter.

This is the same family of decision as "store money as cents" from Week 3 — keep money in integers wherever a comparison or sum happens, only float at the display boundary.

### 6. PostgREST embedded relations come back as arrays

```ts
.select('menu_item_id, date, total_quantity, total_revenue_cents, menu_items(name)')
```

You'd expect `row.menu_items` to be `{ name: string }` because each `daily_summary` references exactly one `menu_item` (many-to-one). PostgREST doesn't know that — it treats every embedded relation uniformly and returns an array. Hence the type annotation `menu_items: { name: string }[] | null` and the access pattern `row.menu_items?.[0]?.name ?? itemId`.

**Subtle bug we hit during build:** the first cut typed it as `{ name: string } | null` and TypeScript was fine because we cast through `unknown`. At runtime, `row.menu_items.name` was `undefined`. Fix: type as array, index `[0]`, fall back to `menuItemId` if missing. **Lesson: PostgREST's response shape is a documented quirk; always check the wire format, not your mental model.**

### 7. Express route ordering matters: `/read-all` before `/:id/read`

Express matches routes in registration order. If `/:id/read` is registered first, a request to `/read-all` would match the `:id` param with the literal string `"read-all"` — and the handler would try to fetch an alert with id `"read-all"` and 404. Registering the literal route first means it short-circuits before the dynamic one. This is the same principle as ordering `case` statements from specific to general in a `switch`.

### 8. Tenant isolation is enforced in code, not the database

Carrying forward from Week 3: every alert query filters by `restaurant_id` derived from `req.user.sub` via `getRestaurantByUserId`. The `POST /:id/read` handler fetches the alert first to check ownership before updating. The database itself has no RLS — we bypass it with the service-role key for prototyping speed.

The cost: **every new route is a new opportunity to leak across tenants.** If somebody adds `POST /api/alerts/:id/delete` and forgets the ownership check, an authenticated user can guess UUIDs and delete other restaurants' alerts. Belongs on the punt list until we flip on RLS.

---

## Patterns and concepts you used

### Discriminated unions / tagged sums
A type-system pattern where each variant of a state carries a literal `kind`/`status` field. The compiler narrows to the right variant when you check the discriminant. Equivalent to **sum types** / **sealed traits** / **Rust enums** / **Haskell ADTs**. Using one is the difference between "make impossible states unrepresentable" and "validate at every render."

### Optimistic UI updates
Mutate local state to the expected outcome *before* the network request resolves. The user sees instant feedback; the network call confirms or (rarely) reverts. The two read flows in `AlertsPage` and the `AlertsBanner` dismiss button both do this. Good UX, but only safe when the operation is idempotent on retry — marking-as-read is, deleting-money would not be.

### Pure / impure separation (continued)
`evaluateAlerts(items): AlertCandidate[]` is pure: no I/O, no `Date.now()`, no Supabase. `fetchItemStats` and `generateAlerts` are impure. This is the same split as `normalizers.ts` vs `ingestSquare.ts` from last week. Pure functions are testable with no fixtures and easy to reason about; impure orchestrators are a thin shell on top.

### Idempotent operations + ON CONFLICT
`generateAlerts` is idempotent in two senses: running it twice produces the same end-state (deduplication ensures it), and a partial failure is safe to retry. `upsert ... ignoreDuplicates: true` is PostgreSQL's `INSERT ... ON CONFLICT DO NOTHING` exposed through PostgREST. Internalizing idempotency is non-negotiable for any system that will be retried — and any production system *will* be retried.

### TOCTOU (time-of-check-to-time-of-use)
A class of race condition where you check a precondition, then act, but state changes between the check and the action. The dedup pattern's two layers (in-memory check + DB unique index) is a textbook fix: the cheap check filters most cases, the strong constraint handles the rare race. Same reason file systems make you `O_CREAT | O_EXCL` instead of "check if it exists, then create."

### Composite indexes for both filter and order
`alerts (restaurant_id, type, menu_item_id, created_at DESC)` — the column order matters. Postgres can use a leading prefix of an index, so this index covers `WHERE restaurant_id = ? AND type IN (...) AND created_at >= ?` *and* `WHERE restaurant_id = ? ORDER BY created_at DESC`. If you swapped `type` and `created_at` you'd lose the second use case. Reading "Use The Index, Luke" by Markus Winand makes this concrete.

### Two-window comparison as a cheap "trend"
Splitting 14 days into "this week (0–6)" and "prior week (7–13)" and diffing aggregates is the simplest non-trivial trend signal you can compute. It's not a real time-series analysis — there's no seasonality correction, no statistical significance test. But for restaurants the weekly cycle dominates everything, so a 7-vs-7 comparison aligned to the same days of week is genuinely informative. Knowing when a simple heuristic is enough is engineering judgment.

### Two-tier rules (LLM vs deterministic)
Insights use Claude — they need to *write English a human enjoys reading* about patterns the system hasn't been told to look for. Alerts are rule-based — operators need to trust them ("why did this fire?" → "look at the rule"). Mixing the two creates the worst of both: opaque alerts you can't trust, and rote insights that don't say anything new. Picking the right tool per problem is the meta-skill.

---

## What you should be able to explain in an interview

After this sprint, you should be able to walk through any of these in 60–90 seconds without notes.

1. **"Walk me through your alerts engine."**
   *"After every Square sync, the backend pulls 14 days of per-item summaries — that table's pre-aggregated, so the read is cheap — and splits them into two non-overlapping 7-day windows. A pure function evaluates three rules: zero current sales after meaningful prior sales, more than 20% week-over-week revenue decline, and breaking into the current top 3 from outside. Each rule has a noise floor in cents so a $0.05 test order doesn't fire alerts. Candidates get stamped with a dedup key — type, menu item, and the Monday of the current UTC week — and we upsert with `ON CONFLICT DO NOTHING` against a unique index. So the same alert can't fire twice in a week, and concurrent syncs can't race past the check."*

2. **"Why a discriminated union instead of `loading` and `error` flags?"**
   *"With three independent flags you can encode states that should be impossible — loading and error both true, for instance. A discriminated union ties optional fields to the variant they belong to: `state.message` only exists when `state.status === 'error'`, and the compiler enforces that. The render block becomes four exhaustive branches. It's not just neater; it removes a whole class of bugs at the type level."*

3. **"How does optimistic UI update work in your alerts page, and when would you not use it?"**
   *"When the user clicks Mark Read, I update local state to `is_read: true` synchronously, then fire the POST. The user sees the change instantly. I'd only do this for operations that are safe to retry and where the failure mode is benign — marking as read, dismissing a banner. I would not do it for irreversible operations like deletion, payment, or anything where the user needs to see confirmation that the server agreed."*

4. **"Why two layers of deduplication?"**
   *"The in-memory check is a TOCTOU race waiting to happen — between the time I read the existing alerts and the time I insert, another sync could have inserted the same row. The unique index plus `ON CONFLICT DO NOTHING` is the real guarantee. The in-memory check is just an optimization to avoid generating obviously-redundant insert payloads."*

5. **"Why didn't you use floats for the 20% threshold?"**
   *"Two reasons. One, IEEE-754 floats don't represent 0.8 exactly, so on edge inputs you'd get inconsistent classifications. Two, multiplying out to `5 * current < 4 * prior` is just integer arithmetic — same answer, no rounding, easier to reason about. I only convert to floats for the display string, where a single-pixel rounding error in the percentage label is irrelevant."*

6. **"What's the difference between your insights and your alerts, and why use Claude for one and not the other?"**
   *"Alerts are deterministic rules an operator can audit — if it fires, you can point at the threshold that triggered. Insights are recommendations written in natural language about patterns the system wasn't pre-programmed to look for, which is exactly what an LLM is good at. You can't audit an LLM the same way, so you don't put it in the path of anything where the user needs to trust the explanation."*

7. **"How do you protect against one tenant reading or modifying another tenant's data?"**
   *"Every protected route runs JWT middleware that puts the user's sub on `req.user`. Then every query joins through `restaurants.user_id` to derive the `restaurant_id` — the client never supplies it. For routes that take a resource ID like `POST /alerts/:id/read`, I fetch the row first, compare its `restaurant_id` to the resolved one, and return 403 on mismatch. There's no RLS at the database — that's a known tradeoff for prototyping speed, and the code-level enforcement means every new route is a new place to get this wrong. When we get past a handful of tenants we'll switch to RLS."*

---

## What to look up if you want to go deeper

- **TypeScript discriminated unions** — read the TS handbook section on "Discriminated Unions" and the rules on narrowing. Then read about *exhaustiveness checking* via `never` to see how the compiler can force you to handle every variant.
- **React 18 StrictMode** — the official "You Might Not Need an Effect" doc and Dan Abramov's "A Complete Guide to useEffect" essay (overreacted.io). The double-invocation behavior is the most-asked Strict Mode question.
- **`AbortController` and `fetch` cancellation** — MDN's `AbortSignal` page is short and worth reading once.
- **PostgREST's embedded resources** — the official docs page on "Resource Embedding" describes exactly when relations come back as arrays vs objects.
- **PostgreSQL `INSERT ... ON CONFLICT`** — the official docs section. Internalize the difference between `DO NOTHING` and `DO UPDATE SET`. We use `DO NOTHING` here because we want a no-op, not a refresh.
- **Composite indexes & "Use The Index, Luke"** by Markus Winand — free online. The chapter on multi-column indexes and the leading-column rule covers exactly what `alerts_restaurant_type_item_created_idx` is doing.
- **TOCTOU / race conditions** — read about file system races (`O_CREAT | O_EXCL`) and database isolation levels (REPEATABLE READ vs SERIALIZABLE). Same concepts, different layers.
- **IEEE-754** — the Wikipedia article is enough. Pay attention to "What every computer scientist should know about floating-point arithmetic" by Goldberg if you want depth.
- **Tailwind JIT mode** — Tailwind's "Content Configuration" docs. The "Dynamic Class Names" warning is the exact issue we worked around.
- **Optimistic updates** — TanStack Query (formerly React Query) docs on optimistic updates. We rolled our own because we don't have RQ, but the conceptual playbook is clearly explained there.
- **Idempotency in distributed systems** — Stripe's engineering blog post "Designing robust and predictable APIs with idempotency" is the canonical industry write-up.

---

## Things you punted (and should track)

- **Alerts are not real-time.** They only run after a sync. If a sync hasn't fired today, alerts are stale. Real fix: trigger `generateAlerts` from a scheduled job instead of piggybacking on sync.
- **`AlertsBanner` polls once on mount.** No subscription, no Supabase Realtime. The banner can show stale unread counts for the lifetime of an open tab.
- **No "snooze" or "ignore this kind of alert" controls.** Every dismissal is binary (read or unread). Operators will eventually want per-item suppression — that becomes another column on `alerts` or a separate `alert_preferences` table.
- **`generateAlerts` swallows errors silently.** Intentional (don't break a sync), but also means a broken alerts engine is invisible. Should log to a structured error sink.
- **Tenant isolation is still in code, not RLS.** Every new alerts route is a new place this can be gotten wrong.
- **The week boundary is UTC.** A restaurant in Honolulu (UTC-10) will see "this week" reset mid-Sunday afternoon locally. Right answer: add a `timezone` column to `restaurants` and thread it through `alertsService`.
- **Three rules is barely an MVP.** Obvious next ones: spike detection (`current > 1.5 * prior`), category-level rollups, day-of-week anomalies. The rule format is structured enough that adding one is a 10-line change.
