# Week 6 — Onboarding, Margin Analysis, and the Production-Hardening Audit (Sprints G + H + Risk Audit)

> Three bodies of work this week, sharing one theme: making the system safe to put in front of a real user. Sprint G fixed the first-run experience. Sprint H added the highest-leverage analytics view. The risk audit closed eight ways the system could quietly corrupt data or leak secrets.

---

## Sprint goal in one sentence

Take the system from "the demo path works" to "a stranger can sign up, connect Square, and trust the numbers" — by polishing onboarding into a 3-step wizard, shipping a Margin Analysis dashboard that ranks items by profitability and velocity, and closing eight latent risks (atomicity, dedup, query scaling, auth fallback, plaintext secrets) before they bite in production.

---

## Why this week matters

Up through Week 5 the system worked on a developer's machine with a hand-seeded database. Two problems were waiting:

1. **The first five minutes for a new user were bad.** Sign up, hit a blank dashboard, no clue what to do. The "no data" state was indistinguishable from "broken."
2. **Several quietly catastrophic bugs were one production incident away.** A delete-then-insert on `daily_summaries` could zero out 30 days of history mid-crash. The auth middleware would silently fall back to a weaker signature scheme on a network hiccup. Square access tokens were stored in plaintext.

Sprint G is the user-facing fix; the audit is the foundations fix; Sprint H is the new analytics view that makes the whole thing feel like a product.

---

## Part 1: Sprint G — Onboarding Polish + Empty-State Flow

### What shipped, in plain English

- A 3-step wizard: create restaurant → connect Square → run first sync.
- Every empty state in the app now points the user at the action that fixes it (usually `/integrations`).
- Every protected backend route now checks "does this user actually own this restaurant?" before doing anything.
- Square access tokens are encrypted before being stored.

### File-by-file

- `restaurantiq-frontend/src/pages/Onboarding.tsx` — Rewritten as a 3-step wizard. `StepCircle` and `Stepper` are presentational components driven by a single `step: 0 | 1 | 2` state. Each step has its own form and its own error/loading state.
- `restaurantiq-frontend/src/components/MenuItemsTable.tsx` — Empty-state card with contextual CTA: "Connect Square" if `pos_connected` is false, "Run sync" if connected. `AbortController` added so unmounting cancels in-flight fetches.
- `restaurantiq-frontend/src/components/InsightsPanel.tsx` — Empty state with `Link to="/integrations"`.
- `restaurantiq-frontend/src/pages/Analytics.tsx` — Empty state checks all three data arrays (revenueTrend, topItems, hourlyDistribution) before showing the CTA.
- `restaurantiq-frontend/src/pages/Integrations.tsx` — Inputs disabled while `connectBusy` is true; hint text shown when not connected.
- `restaurantiq-backend/src/routes/integrations/square.ts` — Tenant ownership check on `/connect` and `/sync`. `/connect` does it atomically via `.eq('id', restaurant_id).eq('user_id', userId)` on the UPDATE — if the restaurant doesn't belong to the user, zero rows update and a 403 is returned. `encryptToken(access_token)` wraps every token before it touches the DB. `/status` moved before the `authMiddleware` registration so it remains unauthenticated.
- `restaurantiq-backend/src/controllers/restaurantController.ts` — `createRestaurant` does a SELECT first and returns 409 if the user already has one. `getRestaurant` and `updateRestaurant` both `.eq('user_id', userId)` so a UUID guess can't read someone else's row. `updateRestaurant` only accepts `name`, `location`, and `doordash_store_id` — credentials and ownership fields are not writable.
- `restaurantiq-backend/src/routes/menuItems.ts` — Ownership check before listing items; null `menu_item_id` skipped in the per-item aggregation so orphaned `daily_summaries` rows don't poison the result Map.

### The redirect-after-create bug

The wizard had a subtle `useEffect` bug worth understanding because it shows up everywhere in real-world React.

The guard that bounces an already-onboarded user to `/` looked like this:

```ts
useEffect(() => {
  if (!loading && restaurant) navigate('/', { replace: true });
}, [restaurant, loading, navigate]);
```

That's correct on first render: a returning user with a restaurant gets sent home. But during the wizard, step 0's submit calls `refresh()` to repopulate `restaurant` after the POST. The next render sees `restaurant` populated — and the effect fires again, redirecting the user away while they're mid-wizard. They'd never see step 1.

The fix:

```ts
useEffect(() => {
  if (!loading && restaurant && step === 0) navigate('/', { replace: true });
}, [restaurant, loading, navigate, step]);
```

The `step === 0` clause says "only redirect from the entry step." Once past step 0, the redirect is suppressed.

The deeper lesson: **`useEffect` runs whenever its dependencies change, not when you intuitively want it to run.** If the same effect should behave differently in different states, that state must be in the condition, not just in the dependency array.

### The multi-tenant ownership pattern

Every protected route now follows one rule:

> `userId` always comes from `req.user.sub` (the JWT). `restaurantId` may come from the URL or body, but is always validated against `userId` on the way in.

This is how we get away with bypassing Postgres Row-Level Security. The service-role key the backend holds can read any row; tenant safety is a **code-review invariant, not a database guarantee**. Miss one `.eq('user_id', userId)` in a controller and you've shipped a tenant-leak bug. The tradeoff: simpler SQL and faster prototyping, at the cost of disciplined code review.

### AbortController + cancelled flag — why both

```ts
let cancelled = false;
const controller = new AbortController();
(async () => {
  try {
    const result = await fetchMargins(controller.signal);
    if (!cancelled) setData(result);
  } catch (err) {
    if (cancelled) return;
    if (err.name === 'AbortError') return;
    setError(err.message);
  }
})();
return () => { cancelled = true; controller.abort(); };
```

- **`controller.abort()`** tears down the network request. Without it, a user who unmounts a component still pays for the bytes coming over the wire.
- **`cancelled`** is the synchronous flag checked *after* awaits resolve. Even if the fetch already returned successfully (abort impossible), the component might have unmounted between `await` and `setData`. Calling `setData` on an unmounted component is a React warning.

The two cover different windows: `abort()` for in-flight requests, `cancelled` for already-resolved-but-unmounted state.

### 409 Conflict vs 403 Forbidden

`createRestaurant` returns **409 Conflict** when a restaurant already exists for the user.

- **403 Forbidden** = you don't have permission. Fundamentally about authorization.
- **409 Conflict** = this can't be done because of the current resource state. Fundamentally about state, not permission.

The user *is* allowed to create a restaurant — they just can't create a second one. A frontend reading 409 knows to show "you already have one" rather than "log in again."

---

## Part 2: Sprint H — Margin Analysis Dashboard

### What shipped

- `GET /api/analytics/margins` — four classification buckets plus a summary object.
- `MarginAnalysis.tsx` — KPI cards, a horizontal Recharts bar chart of top profit contributors, and four tables (one per bucket).

### The `cost_known` boolean: a small bug, a deep lesson

The first version computed margin like this:

```ts
const cost_cents = item.cost_cents ?? 0;
const profit_cents = item.price_cents - cost_cents;
const margin_percent = (profit_cents / item.price_cents) * 100;
```

If `cost_cents` is `null`, `?? 0` substitutes zero, and the math says profit = price, margin = 100%. Every item without cost data shows as a perfect 100% margin item. The dashboard becomes a lie.

The fix: track whether the cost is known as an explicit boolean.

```ts
const cost_known = item.cost_cents != null && item.price_cents > 0;
const cost_cents = item.cost_cents ?? 0;
const profit_cents = cost_known ? item.price_cents - cost_cents : 0;
```

Now margin/profit are only computed when there's actually data. Buckets are filtered to `withKnownCost` before classification.

The general principle: **`null` and "I don't know" are different from `0`.** `??` is a footgun when applied to numeric data without thinking. When collapsing "missing" to "zero," ask: would a downstream consumer be misled? If yes, carry the missingness as a separate flag.

### Quartile-based classification

The four buckets:

1. **Negative margin** — `cost_cents >= price_cents`. Absolute, no quartile.
2. **Repricing candidates** — margin bottom 25%, orders top 25%. High demand, thin margin → small price increases land softly.
3. **Low-velocity premium** — margin top 25%, orders bottom 25%. Profitable when sold, but nobody buys them. Promote.
4. **Healthy performers** — both margin and orders top 25%. Protect these.

Why quartiles instead of fixed thresholds? Because "high margin" depends on cuisine. A pizza place's healthy margin is a fine-dining restaurant's break-even. Quartiles classify items *relative to the rest of this restaurant's menu*.

The `hasEnoughData = calculable.length >= 3` guard exists because quartiles are meaningless with one or two items — the "top 25%" and "bottom 25%" would be the same item. Sections render empty rather than show a misleading classification.

### `chartData` vs `totalProfitCents` — different filters for different questions

```ts
const chartData = allItems
  .filter((item) => item.profit_30d_cents > 0)  // chart: non-negative only
  .sort((a, b) => b.profit_30d_cents - a.profit_30d_cents)
  .slice(0, 10);

const totalProfitCents = withKnownCost.reduce((sum, i) => sum + i.profit_30d_cents, 0);  // true net
```

The chart filters to positive profit because a "top contributors" view showing negative bars alongside positive ones is confusing — the chart answers "who is making us money?"

The summary `totalProfitCents` includes losses (no `Math.max`). The KPI is "30-day net profit," which by definition includes negative-margin items dragging it down. Clamping to zero would be telling a comfortable lie.

**The same number can be displayed two ways depending on the question being asked.** "Who's contributing?" is non-negative. "Are we profitable overall?" is signed.

### PostgREST embedded relations and the `?.[0]` unwrap

PostgREST returns embedded relations as **arrays in every case** — even many-to-one FKs. This keeps the JSON shape uniform. Unfortunate for ergonomics, defensible for consistency. The code handles it:

```ts
const menuItem = row.menu_items?.[0];
itemMap.set(row.menu_item_id, {
  name: menuItem?.name ?? '',
  category: menuItem?.category ?? '',
});
```

### `ON DELETE SET NULL` and orphan rows

`daily_summaries.menu_item_id` has `ON DELETE SET NULL`. When a menu item is deleted, historical summaries keep their revenue numbers but `menu_item_id` becomes `NULL`. This preserves history, but every aggregation must skip nulls:

```ts
if (row.menu_item_id === null) continue;
```

Without this guard, `null` becomes a Map key and you get a "ghost item" in the top-items list with no name and accumulated revenue from every deleted dish. We hit this exact bug (RISK-005). The alternative — `ON DELETE CASCADE` — would have prevented orphans but destroyed history. The chosen tradeoff: history wins, code handles nulls.

---

## Part 3: The Risk Audit — Eight Production-Hardening Fixes

### RISK-001 — Non-atomic `daily_summaries` rebuild

**Old code:** `DELETE ... WHERE date >= ?` then `INSERT ... new rows`.

**Failure mode:** crash between DELETE and INSERT permanently zeros out 30 days of sales history. No rollback; two separate transactions.

**Fix:** upsert-then-prune.

```ts
await supabase.from('daily_summaries').upsert(summaries, { onConflict: 'restaurant_id,menu_item_id,date' });
// only after success:
await supabase.from('daily_summaries').delete().in('id', staleIds);
```

The upsert replaces values in-place. If it fails, prior data is still there. Prune only runs after success.

**The pattern:** delete-then-insert has no fallback state. Upsert-then-prune leaves valid (if stale) data on failure.

### RISK-002 — Order dedup by `external_id` instead of `(timestamp, total)`

Old dedup: "skip if there's already an order with this `ordered_at` and `total_cents`." A fingerprint. Two real orders for $14.50 in the same second from two tables would collide; the second would be silently dropped.

New dedup: Square gives every order a UUID (`external_id`). Collisions are impossible.

**Prefer authoritative IDs over fingerprints when the source provides them.**

### RISK-003 — Three missing UNIQUE constraints (migrations 013–015)

- **013** — `UNIQUE (user_id)` on `restaurants`. Prevents double-create from network retries or race conditions. Without it, `.single()` calls elsewhere start failing with "multiple rows returned."
- **014** — `UNIQUE (restaurant_id, menu_item_id, date)` on `daily_summaries`. The conflict target that makes RISK-001's upsert work. Note: Postgres treats NULLs as distinct in UNIQUE constraints, so multiple orphan rows (`menu_item_id IS NULL`) on different dates coexist correctly.
- **015** — `external_id TEXT` on `orders` plus a partial index `WHERE external_id IS NOT NULL`. Partial because legacy/payments-fallback rows won't have one.

**Learned the hard way:** partial unique indexes and PostgREST `onConflict` don't play well together — PostgREST's conflict-target resolution doesn't reliably match partial indexes. Switched to a regular UNIQUE, which is why RISK-003 and RISK-001 had to land together.

### RISK-004 — N+1 queries in `upsertOrders`

**Old code:** loop over orders one at a time. 3 queries per order = O(3n). A 200-order sync = 600 round trips at ~50ms each = 30 seconds of network time before any actual work.

**New code:** three queries total, regardless of order count.

```
1. SELECT external_id FROM orders WHERE external_id IN (...all of them)
2. INSERT INTO orders (...all new ones)
3. INSERT INTO order_items (...all line items for all new orders)
```

Plus `Promise.race` with a 60-second timeout → 504 on expiry.

**N+1 is the most common scaling bug.** Per-item DB work feels natural and is wrong at scale. When you see a loop doing database work, ask: "can this be one bulk SELECT + one bulk INSERT?"

### RISK-005 — Null key in topItems aggregation

`if (row.menu_item_id === null) continue;` in the analytics aggregation. Without this, null becomes a real Map key and accumulates revenue from every deleted dish into a phantom entry. Same fix in `menuItems.ts`.

Note: JavaScript Maps can store `null` as a key without error (unlike object literals which coerce to `'null'`). The bug is silent.

### RISK-006 — Duplicate Supabase clients

`server.ts` was creating and exporting a `supabase` client. `db.ts` was also exporting one. Four route files imported from the wrong place.

Two clients = double the resources, two connection pools, potential drift. Fix: removed the export from `server.ts`, updated four imports to `'../db'`.

**Singletons should be obvious from their home file.** `db.ts` is the right home for the database client. `server.ts` is bootstrapping, not a resource owner.

### RISK-007 — Auth middleware HS256 fallback (the security-critical one)

**The old code:**
```ts
try {
  req.user = await verifyJwks(token);  // ES256 via JWKS
  return next();
} catch {
  try {
    req.user = verifyHs256(token);     // HS256 symmetric fallback
    return next();
  } catch {
    return res.status(401).json(...);
  }
}
```

JWKS uses ES256 — asymmetric. Supabase's private key never leaves Supabase. HS256 is symmetric: the same `SUPABASE_JWT_SECRET` signs and verifies.

**The vulnerability:** an attacker who can disrupt JWKS (DNS poisoning, network blip, expired cache) forces every request through the HS256 path. If that secret has ever been leaked, every request is forgeable while JWKS is unreachable.

**The fix:** detect mode once, lazily, after env vars load. Lock it. Never fall back.

```ts
type AuthMode = 'jwks' | 'hs256' | 'unconfigured';
let _mode: AuthMode | null = null;

const getMode = (): AuthMode => {
  if (_mode) return _mode;
  if (process.env.SUPABASE_URL) _mode = 'jwks';
  else if (process.env.SUPABASE_JWT_SECRET) _mode = 'hs256';
  else _mode = 'unconfigured';
  return _mode;
};
```

**Why lazy detection?** If we detected at module load time, it runs when the file is `import`ed — before `dotenv.config()` in some startup orderings. `process.env.SUPABASE_URL` would be `undefined` and the mode would lock to `'hs256'` permanently. Lazy detection guarantees `dotenv` has already fired.

**Module-load-time code runs in import order, not startup order.** If your detection depends on `dotenv`, defer it.

### RISK-008 — Plaintext token storage → AES-256-GCM

**The problem:** Square access tokens stored verbatim in the database. Anyone with read access to a backup or an over-permissioned connection could exfiltrate them.

**New module `lib/tokenCrypto.ts`.** Three outputs per encryption: IV + ciphertext + auth tag, stored as `iv:authTag:ciphertext` hex-colon-delimited.

#### What AES-256-GCM does

- **AES-256**: symmetric block cipher, 256-bit key. Same key encrypts and decrypts.
- **GCM** (Galois/Counter Mode): turns AES into a stream cipher and adds authentication.

GCM produces three things:
- **IV**: 12-byte random nonce per encryption. Ensures encrypting the same plaintext twice produces different ciphertext. Prevents correlation attacks.
- **Ciphertext**: the encrypted bytes.
- **Auth tag**: 16-byte MAC over the ciphertext. On decrypt, GCM recomputes and compares. Tampered ciphertext = mismatched tag = decryption failure.

#### Why GCM, not CBC

CBC encrypts but does not authenticate. Bit-flipping attacks and padding oracle attacks are possible against CBC ciphertext. GCM is AEAD (Authenticated Encryption with Associated Data) — it rejects tampered ciphertext outright. **For new code: GCM (or ChaCha20-Poly1305), never CBC.**

#### `decryptTokenSafe` and the `:` sentinel

Existing rows had plaintext tokens. We needed reads to keep working during the transition.

```ts
export function decryptTokenSafe(value: string): string {
  if (!value.includes(':')) return value;  // plaintext pass-through
  try { return decryptToken(value); }
  catch { return value; }
}
```

Square tokens (starting with `EAAA...`) never contain colons. Encrypted tokens always have two (three segments). So `includes(':')` is a cheap format sentinel. **Deploy reads first (accepting both formats), then writes (new format only). Eventually all rows are new format and the sentinel branch is dead code.**

---

## Patterns that ran through the week

- **Defense in depth.** Tenant safety in three layers: JWT carries identity, controllers scope by `user_id`, database UNIQUE constraints prevent pathological double-rows.
- **Fingerprints vs authoritative IDs.** Use the source's UUID when it exists. Timestamp+amount is a last resort.
- **Atomicity = "either both or neither."** Delete-then-insert has two failure points. Upsert is one. Always prefer the smaller failure surface.
- **N+1 is the most common scaling bug.** Per-item DB work feels natural and is wrong at scale. Batch it.
- **Lazy initialization beats eager** when the trigger depends on `process.env` or any side-effect-loaded state.
- **AEAD modes (GCM) over unauthenticated modes (CBC)** for all new encryption.
- **Sentinel-based backward compatibility** lets you migrate stored data without a flag day.
- **Quartiles classify relative to local distribution** — the right benchmark for a single restaurant's menu health.

---

## Bugs caught during the week

### The partial-unique-index dead end
First attempt at migration 014 used a partial unique index excluding `menu_item_id IS NULL`. The migration ran, but the upsert errored: `there is no unique or exclusion constraint matching the ON CONFLICT specification`. PostgREST's conflict-target resolution doesn't reliably match partial indexes (a known gap). Switched to a regular UNIQUE — and because Postgres treats NULLs as distinct in UNIQUE, orphan rows still coexist correctly.

### The redirect-during-wizard
Covered above. An effect that re-fires when its inputs change must guard against firing in states where its action no longer makes sense.

### The 100% margin lie
`?? 0` collapsed unknown costs into "free." Every uncosted item reported 100% profit margin. No error, just a wrong number. Caught by a tester asking "why are these all 100%?" Fixed with the explicit `cost_known` boolean.

### The `/status` route behind authMiddleware
The `/status` health probe was registered after `router.use(authMiddleware)`, making it require a Bearer token. The intent was unauthenticated. Fixed by moving it before the `router.use(authMiddleware)` call.

---

## What you should be able to explain in an interview

**"Walk me through how you handle multi-tenant isolation when RLS is off."**
Every protected route pulls `userId` from the verified JWT (`req.user.sub`) and adds `.eq('user_id', userId)` to every query that touches a tenant-owned row. Trust the JWT for identity, never trust the request body for ownership. The tradeoff: one missed `.eq` in a controller leaks across tenants. We accept that for now because we have a small, code-reviewed surface. Once we hit real scale, RLS goes back on.

**"Why is delete-then-insert worse than upsert for rebuilding derived data?"**
Atomicity. Delete and insert are two separate writes. If the process dies between them, you've permanently destroyed the data the delete removed. Upsert collapses replacement into one operation: if it fails, the old row is still there. The worst case is "summaries are slightly stale," not "summaries are gone."

**"Why did you ditch the HS256 fallback in your auth middleware?"**
It was a security hole, not a safety net. JWKS uses ES256 — asymmetric, Supabase's private key never leaves Supabase. HS256 is symmetric — anyone with the secret can forge tokens. The old middleware tried JWKS and on any failure fell back to HS256. An attacker who could disrupt JWKS could force every request through the weaker path. We now detect mode once, lazily after env vars load, and lock it. JWKS-mode never falls back.

**"Explain the IV and the auth tag in AES-GCM."**
The IV is a 12-byte random nonce generated fresh for every encryption. It mixes into the keystream so encrypting the same plaintext twice produces different ciphertext. Without it, identical inputs produce identical ciphertexts and an attacker watching the database can match them up. The auth tag is a 16-byte MAC computed over the ciphertext during encryption. On decrypt, GCM recomputes it and compares — a mismatch means the ciphertext was tampered with and decryption fails. The IV prevents correlation; the auth tag provides integrity. Both must be stored alongside the ciphertext.

**"What's an N+1 query and how did you eliminate it in the order sync?"**
N+1 is when you do one query to get a list, then one query per item. Our `upsertOrders` did three queries per order — SELECT to dedup, INSERT for the order, INSERT for line items. For 200 orders: 600 round trips. We rewrote it to three total queries: one bulk SELECT for dedup, one bulk INSERT for orders, one bulk INSERT for line items. Sync time dropped from tens of seconds to under one.

**"You found a bug where every uncosted item showed 100% margin. What was the fix?"**
`cost ?? 0` substituted zero for null, and `(price - 0) / price = 100%`. Every uncosted item looked like a perfect-margin item. The fix was an explicit `cost_known` boolean — only compute margin when it's true; uncosted items don't enter classification. The general lesson: `null` is not `0`. Collapsing missing into zero is misleading for ratios and profitability math.

**"Why does PostgREST return embedded relations as arrays even for many-to-one FKs?"**
Consistency — the JSON shape is uniform whether you embed a many-to-one or a one-to-many. The tradeoff is an `?.[0]` unwrap for many-to-one cases. Predictable beats clever.

---

## Things punted (track these)

- **Square refresh-token rotation.** Tokens are encrypted at rest but expire after 30 days. No refresh flow yet — operators must re-paste tokens manually.
- **`PAYMENTS_FALLBACK` path.** Square v37 SDK mishandles undefined positional args in the payments API. Gated behind env flag until we have a legacy-account customer.
- **`refreshDailySummaries` is O(n) in memory.** Loads every 30-day order into Node, groups in a Map. For high-volume restaurants this could OOM. Long-term fix: push the aggregation into SQL with `INSERT ... SELECT ... GROUP BY`.
- **No write path for `cost_cents`.** Square doesn't expose costs and there's no UI for operators to enter them. Margin Analysis is mostly empty for real users until we ship an "Edit menu item" form.
- **Encryption key rotation.** `TOKEN_ENCRYPTION_KEY` is a static value. Rotating requires decrypt-with-old + re-encrypt-with-new — no infrastructure for that yet.
- **`createRestaurant` 23505 → 409 translation.** The 409 guard is SELECT-then-INSERT, which is racy. The UNIQUE constraint catches concurrent inserts at the DB level, but the controller currently surfaces `23505 unique_violation` as a 500, not a 409. Should catch the Postgres error code and translate.

---

## What to look up if you want to go deeper

- **NIST SP 800-38D** — the AES-GCM spec. Read sections 5 and 8 on IV uniqueness (reusing an IV with the same key leaks the keystream).
- **RFC 7517 (JWK)** and **RFC 7519 (JWT)** — understand what's inside the token your middleware verifies.
- **PostgREST docs: "Resource Embedding"** — why the array-shape choice; how `onConflict` resolves to constraints vs partial indexes.
- **"Designing Data-Intensive Applications" by Kleppmann, ch. 7** — RISK-001's atomicity failure is a textbook write-skew adjacent scenario.
- **"Cryptography Engineering" by Ferguson, Schneier, Kohno** — the authenticated encryption chapter is the cleanest explanation of why GCM is the modern default.
- **"Use The Index, Luke" by Markus Winand, partial indexes section** — explains why partial unique indexes interact awkwardly with SQL conflict-target syntax.
- **MDN: AbortController + AbortSignal** — read once and you'll stop writing fetch effects without it.
