# Week 7 — Manual Cost Entry: Closing the Loop on Margin Analysis (Sprint I)

> One feature this week, but it unlocks an entire dashboard. Square never tells us what an item *costs* to make, so `menu_items.cost_cents` was almost always `null` — which meant the Margin Analysis layer we shipped in Week 6 was beautiful and mostly empty. Sprint I builds the missing write path: a small, well-guarded form that lets an owner type in a cost and watch the profitability view come alive.

---

## Sprint goal in one sentence

Give restaurant owners a way to manually edit a menu item's `name`, `category`, and `cost_cents` — entered as dollars, stored as integer cents, carried as `null` when unknown — so the Margin Analysis dashboard finally has the cost data it was designed to consume.

---

## Why this week matters

Week 6 ended with a punted item that read, almost verbatim: *"No write path for `cost_cents`. Square doesn't expose costs and there's no UI for operators to enter them. Margin Analysis is mostly empty for real users until we ship an 'Edit menu item' form."*

That's the gap this sprint closes. It sounds small — it's one `PATCH` route and one modal — but it's the difference between a feature that demos and a feature that *works*. Without a cost, every margin computation in `/analytics/margins` short-circuits (the `cost_known` guard from Week 6 returns `false`, and the item drops out of every bucket). The whole point of the costliest analytics view in the app is dark until someone can type "4.50" into a box.

There's a second reason it matters disproportionately: **this is money-input code**. Until now, every cent in the system *originated* from Square — already an integer, already authoritative. This is the first time a human types a number that becomes money in our database. That makes it the first place a fat-fingered "12.555" or a malicious `cost_cents: -1` can enter the pipeline, so the validation has to be real on both sides of the wire.

---

## How this sprint was built (process note)

This used the standard agent-team flow, and the coordination is worth calling out because it's why the front and back ends fit together cleanly:

1. **The API contract was written first.** `PATCH /api/restaurants/:restaurantId/menu-items/:itemId`, body is any subset of `{ name, category, cost_cents }`, response is the standard `{ data, error }` envelope with the full updated row. Once that was pinned down, backend-agent and frontend-agent built in parallel against the same shape instead of guessing about each other.
2. **qa-agent ran an independent audit** focused on two things: financial integrity (can a bad number become bad money?) and tenant isolation (can I edit someone else's item?). No critical or high findings. Three low-severity items were caught and fixed — and all three are genuinely instructive, so they're in the bug section below:
   - the sub-cent regex (a `12.555` could slip through an earlier looser check),
   - the modal's `AbortController` (a save firing into an unmounted component),
   - the `category` coalescing in `/margins` (the API claimed `category: string` while sometimes returning `null`).

The lesson in the process itself: **a contract written before the code is a synchronization primitive.** Two agents working in parallel against the same agreed shape don't have to negotiate later.

---

## What shipped, in plain English

- Owners can now click **Edit** on any menu item and change its name, category, and cost.
- Cost is typed in dollars (e.g. `12.50`) and stored as cents (`1250`) — never a float.
- Leaving the cost blank means **"we don't know this cost,"** not "it's free." The system carries that uncertainty honestly all the way through.
- A banner on the menu table tells you exactly how many items are still missing cost data, so you know what's blocking your margin view.
- The Margin Analysis empty-state button now sends you to the right place (the Dashboard, where costs are entered) instead of the wrong place (Integrations).

---

## File-by-file (every file touched, what it is + why it exists)

- **`restaurantiq-backend/src/routes/menuItems.ts`** — Adds a `PATCH /:restaurantId/menu-items/:itemId` handler below the existing `GET`. It verifies ownership first, then runs a tenant-scoped `UPDATE`, validating each field independently. No migration was needed: `cost_cents` already existed as a nullable `integer` column from the original schema. This is the entire backend of the sprint.
- **`restaurantiq-frontend/src/components/EditMenuItemModal.tsx`** — NEW. The dialog that collects the edit. It owns the dollars→cents boundary conversion (`parseDollars`), client-side validation with inline messages, accessibility (Escape/backdrop close, `role="dialog"`, `aria-modal`, disabled-while-saving), an `AbortController` that cancels an in-flight save on unmount, and a diff step that only sends fields the user actually changed.
- **`restaurantiq-frontend/src/components/MenuItemsTable.tsx`** — UPDATED. `cost_cents` becomes `number | null` in the row type. Null cost renders as an amber **"Missing cost"** badge instead of a misleading `$0.00`. Adds a per-row Edit button, a "N items missing cost data" banner, and a `handleSaved` merge that updates only the three editable fields while preserving the locally-held analytics fields the PATCH doesn't return.
- **`restaurantiq-frontend/src/pages/MarginAnalysis.tsx`** — Small change: the empty-state CTA now links to `/` (the Dashboard, where the menu table and its Edit buttons live) instead of `/integrations`. The old link sent confused users to reconnect Square when the actual problem was missing cost data.
- **`restaurantiq-backend/src/routes/analytics.ts`** — One-line correctness fix in the `/margins` enriched object: `category: item.category ?? ''`. The TypeScript interface promised `category: string`, but the DB column is nullable, so without the coalesce the response was a runtime lie waiting to crash a `.toLowerCase()` somewhere downstream.

---

## The core design idea: `null` is "unknown," and we never let it become `0`

This is the thread that runs through every file, and it's a direct callback to Week 6's "100% margin lie" bug. Internalize this and the rest of the sprint reads itself.

A cost can be in one of two states: **known** (an integer number of cents) or **unknown** (`null`). These are different facts, and collapsing them is how you get a dashboard that lies. If you treat an unknown cost as `0`:

```
profit = price - 0 = price
margin = profit / price = 100%
```

Every uncosted burger reports a perfect 100% margin and floats to the top of "Healthy Performers." The number is wrong, and there's no error — the worst kind of bug.

So `null` is preserved as a first-class value at **every layer**:

- **Database**: `cost_cents` is a nullable `integer`. Null is a legal, meaningful value.
- **API (PATCH)**: `cost_cents: null` is explicitly allowed and stored as-is (`menuItems.ts:152–171`). It is never coerced to `0`.
- **API (margins)**: the `cost_known` boolean (`analytics.ts:222`) gates every computation. Unknown-cost items get `profit_cents: 0`, `margin_percent: 0`, and are filtered out of `withKnownCost` before any ranking or averaging happens.
- **Frontend table**: null renders as a "Missing cost" badge (`MenuItemsTable.tsx:52`), never `$0.00`.
- **Frontend modal**: an empty cost field round-trips to `null` to *clear* a cost (`EditMenuItemModal.tsx:27`), and a stored null pre-fills as an empty string (`centsToDollarString`, line 50–53).

The general principle, restated for the file you'll most likely forget it in: **`??` is a footgun on numeric columns.** Before you write `value ?? 0`, ask "will a downstream consumer be misled by treating missing as zero?" For money and ratios, the answer is almost always yes.

---

## Deep dive: the `PATCH` handler — order of operations is the security model

The handler (`menuItems.ts:90–190`) does four things in a deliberate order, and the order is the point.

### 1. Ownership check *before* anything else

```ts
const { data: owned } = await supabase
  .from('restaurants')
  .select('id')
  .eq('id', restaurantId)
  .eq('user_id', userId)   // userId comes from req.user.sub — the verified JWT
  .maybeSingle();
if (!owned) return res.status(403).json({ data: null, error: 'Restaurant not found or access denied' });
```

`userId` is pulled from `req.user.sub`, which the auth middleware set after verifying the Supabase ES256 JWT (Week 6's RISK-007 work). The `restaurantId` comes from the URL — i.e. from the caller — so it's untrusted until we prove the JWT's user owns it. This is the exact multi-tenant pattern from Week 6: **trust the JWT for identity, validate everything else against it.** We bypass Postgres Row-Level Security (the backend holds the service-role key, which can read any row), so this `.eq('user_id', userId)` is the *only* thing standing between tenants. Miss it and you've shipped a cross-tenant write.

### 2. The tenant-scoped UPDATE as a second line of defense

```ts
const { data: updated } = await supabase
  .from('menu_items')
  .update(updates)
  .eq('id', itemId)
  .eq('restaurant_id', restaurantId)   // belt AND suspenders
  .select('...')
  .maybeSingle();
if (!updated) return res.status(404).json({ data: null, error: 'Menu item not found' });
```

Even after the ownership check passes, the UPDATE itself is scoped by *both* `id` and `restaurant_id`. So if someone passes a valid `restaurantId` they own but an `itemId` belonging to a *different* restaurant, the `WHERE id = ? AND restaurant_id = ?` matches **zero rows**. Supabase returns no row, `updated` is null, and we send a clean **404** — not a silent success, not a leak. This is defense in depth: the explicit ownership check and the scoped write are two independent guards that would each have to fail for a tenant boundary to break.

Note the choice of **404 over 403** here. A foreign item id isn't "you're forbidden from this item" — from this tenant's perspective, the item simply *doesn't exist*. 404 is also better for privacy: a 403 would confirm the id is real but belongs to someone else; a 404 reveals nothing.

### 3. Per-field validation, defending against a bypassed client

Each field is validated only if present (`!== undefined`), so a partial PATCH is legal — you can update just the cost without touching the name. The interesting one is `cost_cents` (`menuItems.ts:152–171`):

```ts
if (cost_cents !== undefined) {
  if (cost_cents !== null) {                       // null is allowed — it means "unknown"
    if (typeof cost_cents !== 'number')   ... 400  // not a string, not undefined
    if (!Number.isFinite(cost_cents))     ... 400  // rejects NaN, Infinity, -Infinity
    if (!Number.isInteger(cost_cents))    ... 400  // rejects 12.5 — cents are integers
    if (cost_cents < 0)                   ... 400  // no negative cost
    if (cost_cents > 100000000)           ... 400  // sanity ceiling: $1,000,000
  }
  updates.cost_cents = cost_cents;
}
```

Why all five guards when the frontend already validates? **Because the frontend is a suggestion, not a guarantee.** Anyone can hit this endpoint with `curl` and a stolen-from-devtools bearer token. The client-side `parseDollars` exists for UX (instant feedback, no round trip); the server-side guards exist for *integrity* (the client can be skipped entirely). This is textbook **defense in depth on input** — never trust data crossing a trust boundary, even if you also validate it before it gets there.

Each guard rejects a specific category of bad input:
- `typeof !== 'number'` — catches `"4.50"` sent as a string.
- `!Number.isFinite` — catches `NaN` and `Infinity`, which *are* of type `number` in JS but are never valid money.
- `!Number.isInteger` — enforces the cents invariant. A `1250.5` is a half-cent and meaningless.
- `< 0` and `> 100000000` — a domain range. The ceiling is arbitrary but defensible; it stops absurd values from poisoning the quartile math in `/margins`.

### 4. No migration was needed

Worth stating plainly because it's a real (good) decision: `cost_cents` was already a nullable `integer` in the schema from day one. The column was *there*; what was missing was a way to write to it. So this sprint added zero SQL and ran zero migrations. The lesson: a well-designed schema anticipates writes that don't exist yet.

---

## Deep dive: the dollars→cents boundary (`parseDollars`)

`EditMenuItemModal.tsx:25–47` is where a human's "12.50" becomes the machine's `1250`. Three details carry real weight.

### The regex rejects sub-cent input

```ts
if (!/^\d*\.?\d{0,2}$/.test(trimmed) || trimmed === '.') {
  return { cents: null, error: 'Enter a valid dollar amount with up to two decimals (e.g. 12.50).' };
}
```

`^\d*\.?\d{0,2}$` allows zero or more digits, an optional single decimal point, and **at most two** digits after it. So `12.50` passes, `12.5` passes, `12` passes — but `12.555` is rejected. The `|| trimmed === '.'` clause handles the one degenerate string the regex would otherwise accept (a lone `.` matches `\d*\.?\d{0,2}`). This was one of the three QA fixes: an earlier, looser check let three-decimal input through, which `Math.round` would then silently absorb — turning `12.555` into `1256` cents without the user knowing their input was distorted. Rejecting it outright is the honest behavior.

### `Math.round`, not truncation

```ts
const cents = Math.round(dollars * 100);
```

`parseFloat("12.50") * 100` does not always yield exactly `1250` in IEEE-754 floating point — it can be `1249.9999...`. Truncating with `Math.floor` or `| 0` would give `1249` — you'd lose a cent on input. `Math.round` gives the correct `1250`. The float exists for exactly one multiply at the very edge of the system, and we round it back to an integer immediately. This is the same money discipline as Week 6's "integer cents at every layer" rule, applied at the one boundary where dollars are unavoidable: the input box.

### Empty string → `null` (clear the cost)

```ts
const trimmed = raw.trim();
if (trimmed === '') return { cents: null, error: null };
```

A blank field is not an error and not zero — it's the user saying "I don't know this cost, clear it." This is how the modal lets an owner *un-set* a cost, feeding the null back through the PATCH and back into the "Missing cost" state. The symmetry with `centsToDollarString` (null → `''`) means the field round-trips losslessly.

---

## Deep dive: the optimistic-ish merge in `MenuItemsTable`

`handleSaved` (`MenuItemsTable.tsx:120–138`) is subtle and worth slowing down on.

The menu table rows carry **more fields than the PATCH returns**. A row has `revenue_30d_cents`, `orders_30d`, and `trend` — analytics computed by the GET handler. The PATCH only returns the editable columns (`id, name, category, price_cents, cost_cents, source`). So a naive `prev.map(row => row.id === updated.id ? updated : row)` would *wipe out* the analytics fields, blanking the revenue and trend columns until the next full refetch.

The fix is a **field-level merge**:

```ts
return prev.map((row) => {
  if (row.id !== updated.id) return row;
  return {
    ...row,                       // keep everything, especially revenue_30d_cents / orders_30d / trend
    name: updated.name,           // overwrite only what the server changed
    category: updated.category,
    cost_cents: updated.cost_cents,
  };
});
```

This keeps the locally-held analytics intact while applying the authoritative server values for the three edited fields. It avoids a refetch — the UI updates instantly — without inventing data the server didn't send.

### "Rollback" here means: never mutate state on failure

There's an elegant property to how failure is handled. In a classic *optimistic* update you'd mutate state immediately, fire the request, and roll back if it fails. Here, the order is reversed: **state is only ever touched inside `onSaved`, which is only called on a successful response** (`EditMenuItemModal.tsx:147`). If the PATCH fails, `onSaved` never fires, `handleSaved` never runs, and the table simply still shows the old row. The modal stays open and shows the server's error message.

So "rollback" is trivial because there's nothing to roll back — we never optimistically wrote anything. This is the simplest possible correctness story: **the only way the table changes is when the server confirms the change.** It costs a moment of latency (the user waits for the round trip), but it makes a stale-after-failure state impossible.

---

## Patterns and concepts you used (mechanics → CS concepts)

- **Defense in depth (input validation).** The same rules run on the client (UX) and the server (integrity). Neither layer trusts the other to have done the job. The frontend can be bypassed; the backend is the real boundary.
- **Trust boundaries.** The JWT's `sub` is trusted; the URL's `restaurantId` and the body's fields are not, until validated against the trusted identity. Knowing *which* inputs cross a trust boundary is most of security.
- **Null as a distinct domain value (three-valued logic).** "Known cost," "unknown cost," and "zero cost" are three states, not two. SQL's nullable columns model this natively; the application has to respect it instead of flattening to two.
- **Integer money / avoiding IEEE-754.** Floats are non-associative — summing many small floats drifts. We keep money as integer cents everywhere and tolerate a float only for the single `dollars * 100` multiply, which we immediately `Math.round` back to an integer.
- **Idempotent-by-scoping writes.** The `UPDATE ... WHERE id = ? AND restaurant_id = ?` makes a foreign id a no-op that returns zero rows → 404. The query's scope *is* the authorization check.
- **Partial updates (PATCH semantics).** Only fields present in the body are touched; absent fields are left alone. This is what distinguishes `PATCH` (partial) from `PUT` (replace) in REST.
- **Diffing before sending.** The modal computes which fields actually changed and sends only those (`EditMenuItemModal.tsx:110–120`). Less data on the wire, smaller blast radius, and a no-change "save" becomes a free `onClose()` with no request at all.
- **The response contract as a coupling point.** Both ends honor `{ data, error }`. The merge logic depends on knowing exactly which fields the PATCH returns vs. which the GET adds — the contract is what lets the frontend reason about that.

---

## Bugs caught during the sprint (the three QA fixes)

### The sub-cent regex

An earlier version of `parseDollars` validated loosely enough that `12.555` reached `Math.round(dollars * 100)`, which quietly produced `1256` cents. The user typed a three-decimal amount and got a silently rounded value with no warning. Fixed by tightening the regex to `^\d*\.?\d{0,2}$` (plus the lone-`.` guard) so sub-cent input is *rejected* with a message rather than *absorbed*. The lesson: when input is ambiguous, refuse it loudly instead of guessing quietly — especially for money.

### The modal's missing AbortController

If a user clicks Save and then navigates away (or the modal otherwise unmounts) before the PATCH resolves, the `onSaved` / `setServerError` calls would fire into a component that no longer exists — a React state-update-on-unmounted-component warning, and a latent source of confusing behavior. Fixed by storing an `AbortController` in a ref and aborting it in a cleanup effect, with the catch block swallowing `AbortError` and the `finally` only clearing `saving` if the request wasn't aborted. This is the same `AbortController` discipline from Week 6's fetch effects, applied to a mutation instead of a read.

### The `category` coalescing lie

`/analytics/margins` declared `category: string` in its `MarginItem` interface, but `menu_items.category` is nullable, so an uncategorized item returned `category: null` while claiming to be a string. TypeScript believed the lie at compile time; the runtime didn't. Any frontend code calling a string method on that field (a `.toLowerCase()`, a `.trim()`) would throw on real data. One-line fix: `category: item.category ?? ''` (`analytics.ts:233`). The general lesson: **a type annotation is a promise, and the boundary where data enters your typed world is where promises get broken.** Coalesce nullable DB columns to their declared type at the read boundary, or widen the type to `string | null` and handle it — but don't let the two disagree.

---

## What you should be able to explain in an interview

**"You let users type money into a form. Walk me through how a dollar value becomes a stored integer, and what could go wrong."**
The user types into a text field — say "12.50". On save, a `parseDollars` function trims it and runs it against a regex that allows at most two decimal places, so "12.555" is rejected outright with a message rather than silently rounded. Then it does `Math.round(dollars * 100)` — round, not truncate, because `12.50 * 100` in floating point can come out as `1249.9999`, and truncating would lose a cent. That integer goes to the server. The server doesn't trust any of that — it independently checks the value is a finite integer ≥ 0 and under a ceiling, because the client can be bypassed with curl. The cents are stored as an integer column. Money is integer cents everywhere; the only float in the whole path is that one multiply at the input box, and we round it away immediately.

**"Why is a missing cost `null` instead of `0` in your system, and what breaks if you get that wrong?"**
Because "I don't know this item's cost" and "this item is free" are different facts, and margin math conflates them catastrophically if you flatten them. If `null` becomes `0`, then profit equals price and every uncosted item reports a 100% margin — it floats to the top of the "most profitable" list, and the dashboard is lying. We had exactly this bug in a prior sprint. So `null` is carried end to end: it's a legal value in the column, the PATCH stores it as-is to let users clear a cost, the margins endpoint gates all computation behind a `cost_known` boolean, and the table renders it as a "Missing cost" badge, never `$0.00`.

**"How do you stop one tenant from editing another tenant's menu item, given you've turned off Row-Level Security?"**
Two independent guards. First, I pull the user id from the verified JWT — never from the request — and check that the restaurant in the URL actually belongs to that user; if not, 403. Second, even after that passes, the UPDATE itself is scoped `WHERE id = itemId AND restaurant_id = restaurantId`. So if someone passes an item id from a restaurant they don't own, the update matches zero rows, Supabase returns no row, and I send a 404. Either guard alone would mostly work; together they're defense in depth. The tradeoff of bypassing RLS is that this scoping is a code-review invariant rather than a database guarantee — miss one `.eq` and you leak — which is fine at our scale and would be revisited past a handful of tenants.

**"Your edit endpoint only returns some of the fields the table displays. How do you update the UI without blanking the rest?"**
The table rows carry analytics fields — 30-day revenue, order count, trend — that the PATCH doesn't return, because those are computed by a different (GET) endpoint. So on save I do a field-level merge: spread the existing row, then overwrite only name, category, and cost from the server response. That keeps the analytics intact and updates instantly without a refetch. And I never optimistically mutate before the request — the merge only runs on a successful response — so if the save fails there's literally nothing to roll back; the table just still shows the old values and the modal shows the error.

**"Why validate on the server if you already validate in the browser?"**
They serve different jobs. The browser validation is UX — instant feedback, no round trip, catches typos before they cost a request. The server validation is integrity — it's the actual trust boundary, because anyone can skip the browser and hit the endpoint directly with a token from devtools. If I only validated client-side, a single curl with `cost_cents: -1` or `"cost_cents": 12.5` would corrupt my money data. So the server independently checks type, finiteness, integer-ness, and range. The client is a convenience; the server is the contract.

---

## What to look up if you want to go deeper

- **RFC 5789 (PATCH method for HTTP)** — the formal semantics of partial update, and why PATCH ≠ PUT. Our handler is a clean example: absent fields are untouched, present fields are validated and applied.
- **What Every Computer Scientist Should Know About Floating-Point Arithmetic (Goldberg, 1991)** — the canonical explanation of why `0.1 + 0.2 !== 0.3` and why `Math.round(dollars * 100)` is necessary rather than paranoid.
- **Martin Fowler, "Money" pattern (Patterns of Enterprise Application Architecture)** — the argument for representing money as an integer minor-unit + currency rather than a float, which is exactly our `_cents` convention.
- **MDN: `Number.isInteger` and `Number.isFinite`** — note these are the *static* methods, not the global `isFinite`/`parseInt`, and they don't do type coercion. That's precisely why they're the right guards for untrusted input.
- **OWASP Input Validation Cheat Sheet** — the "validate on the server, always" principle, and the trust-boundary framing. The client-side check is for users; the server-side check is for attackers.
- **WAI-ARIA Authoring Practices: Dialog (Modal) Pattern** — what `role="dialog"`, `aria-modal`, `aria-labelledby`, focus management, and Escape-to-close are *supposed* to do. The modal implements most of this (focus-on-open, Escape, labelled title); a fuller implementation would add a focus trap.
- **SQL three-valued logic (NULL semantics)** — why `NULL = NULL` is not `TRUE`, and why nullable columns model "unknown" so cleanly. The whole `null ≠ 0` discipline is this idea applied in application code.

---

## Things punted (technical debt with names)

- **No focus trap in the modal.** Escape, backdrop-click, and focus-on-open are implemented, but Tab can still move focus to elements *behind* the dialog. A complete WAI-ARIA modal traps focus within the dialog until it closes. Named follow-up: add a focus trap (or adopt a headless dialog primitive).
- **No optimistic update.** The save waits for the full round trip before the row changes. It's correct and simple, but on a slow connection the user stares at a spinner. If this ever feels slow, the upgrade is a true optimistic write with rollback on failure — at the cost of the "nothing to roll back" simplicity we currently enjoy.
- **No bulk cost entry.** Costs are entered one item at a time through the modal. A restaurant with 80 items and 60 missing costs has 60 modals to open. A CSV import or an inline-editable column would scale better; the "N items missing cost data" banner is currently the only nudge.
- **`price_cents` is read-only.** The modal shows price but can't edit it — price still comes only from Square. If an owner wants to model a price change before pushing it to Square, there's no path. Deliberate for now (price is POS-authoritative), but worth naming.
- **No audit trail on cost edits.** A cost change overwrites the old value in place with no history. For a number that drives profitability reporting, "who changed this cost from $3.00 to $8.00 and when?" is an unanswerable question today. A `cost_history` table or an updated_by/updated_at pair would fix it.
- **The `> 100000000` ceiling is a magic number.** It's duplicated as `1_000_000` dollars in the frontend and `100000000` cents in the backend, with no shared constant. If the limit ever changes, two files must change in lockstep or they'll disagree. Extract a shared bound.
