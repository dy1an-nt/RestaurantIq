# Week 8 — A Second Channel, and Tokens That Refresh Themselves (Sprint J)

> Until this sprint, "unified order data" was a promise the schema made but the code only half-kept: every order in the system came from Square. Sprint J makes the promise real. It adds **DoorDash as a first-class order source** — and, just as importantly, it does so by *extracting* the proven Square ingestion logic into a shared pipeline instead of copy-pasting it. Along the way it hardens the thing that quietly breaks every long-lived integration: **OAuth tokens that expire.** Both Square and DoorDash now refresh their own access tokens, encrypt them at rest under a rotatable key, and migrate old ciphertext forward transparently. This is also the first sprint with a real **Jest test suite** (29 tests) guarding the money- and security-critical paths.

---

## Sprint goal in one sentence

Make DoorDash a second order source that flows into the exact same `daily_summaries` (and therefore the same margins, insights, and alerts) as Square — by lifting ingestion's write path into a shared, source-parametrized layer — and give both integrations self-refreshing, encryption-rotatable OAuth tokens so a sync never dies on an expired credential.

---

## Why this week matters

The product's headline is "unified analytics across POS *and* delivery." For seven sprints that was structurally true (the schema has `source`, orders carry a channel) but practically false: there was exactly one ingestion path, `ingestSquare.ts`, and everything in the dashboard was Square data wearing a "unified" label. Sprint J is where the second channel actually lands rows in the `orders` table.

There were two ways to build it. The tempting one is to copy `ingestSquare.ts` to `ingestDoorDash.ts` and find-and-replace "square" with "doordash." That works on Monday and rots by Friday — the dedup logic, the order-item linkage, the daily-summary rebuild are *subtle*, and now they live in two places that will drift. The choice this sprint made instead: **extract the write path into a shared `services/ingestion/` layer that takes the source as a parameter,** then make both Square and DoorDash thin "fetch + normalize" front-ends that hand normalized rows to the same persistence functions. That's the difference between two channels and N channels.

The second reason this week matters is less visible but more dangerous: **OAuth access tokens expire.** Square's expire after ~30 days; DoorDash's are short-lived. Before this sprint, an expired token meant a sync that failed opaquely and an operator who had to manually reconnect — or, worse, silently stale data. Token refresh is the unglamorous plumbing that turns a demo integration into one that survives a month unattended. And because we're now storing *two* tokens per channel (access + refresh) encrypted at rest, the sprint also added **encryption-key rotation** — so a leaked or aged key can be retired without a flag day where every stored credential becomes unreadable.

---

## How this sprint was built (process note)

This followed the standard agent-team flow, and two coordination decisions are worth calling out:

1. **The shared types were the contract this time, not an HTTP shape.** Last sprint the synchronization primitive was an API contract between frontend and backend. Here it's `services/ingestion/types.ts` — `MenuItemRow`, `OrderRow`, `NormalizedOrder`, `OrderSource`. Once those row shapes were pinned, the DoorDash normalizer and the shared persistence layer could be built against the same target independently. The normalizers' *entire job* is "map a vendor's JSON onto these shapes"; persistence's entire job is "write these shapes." Neither needs to know about the other's vendor.

2. **The Square extraction was a refactor-under-test, not a rewrite.** The risky move in this sprint isn't adding DoorDash — it's *moving* Square's battle-tested ingestion code out of `ingestSquare.ts` and into `persistence.ts`. To do that safely, the logic was lifted **verbatim plus a `source` parameter** (the file even says so in its header comment), and the new Jest suite was written to lock down the behaviors most likely to break silently: token refresh, key rotation, and the error-leak fix. The lesson in the process: **when you extract shared code from a proven implementation, preserve it literally and let parametrization be the only change** — then you're reasoning about one small delta, not a reimplementation.

A note on the security follow-up that opened this session: last sprint's hardening fixed the raw-`error.message` leak only in `createRestaurant`. This session closed the same leak in `getMyRestaurant`, `getRestaurant`, and `updateRestaurant` — all four handlers now log the real error server-side and return a generic client message. That's covered in the bug section below.

---

## What shipped, in plain English

- **DoorDash is now a connectable order source.** An owner can connect a DoorDash store, sync it, and its menu items + orders show up in the same dashboard as Square — counted in the same revenue, margins, and alerts.
- **A `/sync` for DoorDash** that pulls catalog + orders, dedupes on re-run (so syncing twice doesn't double-count), and rebuilds the shared daily summaries.
- **Mock mode for DoorDash** ships deterministic sandbox data (5 items, 12 orders spread across 6 days) so the "two channels at once" story is demonstrable end-to-end without partner API access.
- **Self-refreshing tokens for both channels.** When an access token is expired (or about to be), the sync refreshes it automatically using the stored refresh token, persists the new one encrypted, and continues — no manual reconnect.
- **Encryption-key rotation.** Tokens are encrypted under an *active* key; old keys are kept for decryption only. Values stored under a retired key are transparently re-encrypted under the active key the next time they're read.
- **A real test suite** — 29 Jest tests across token crypto, the Square refresh flow, the Square OAuth client, and the restaurant controller.
- **Two migrations** adding the encrypted refresh-token + expiry columns for DoorDash (016) and Square (017).

---

## File-by-file (every file touched, what it is + why it exists)

### The shared ingestion pipeline (the architectural heart of the sprint)

- **`restaurantiq-backend/src/services/ingestion/types.ts`** — NEW. The contract every order source normalizes into: `OrderSource` (`'square' | 'doordash'`), `MenuItemRow`, `OrderRow`, `OrderItemRow`, `NormalizedOrder`, and the uniform `IngestResult` returned by every `/sync`. This is the narrow waist of the whole pipeline — vendors fan in to these shapes, persistence fans out from them.
- **`restaurantiq-backend/src/services/ingestion/persistence.ts`** — NEW. The shared write path, lifted verbatim from `ingestSquare.ts` plus a `source` parameter. Four exported functions: `upsertCatalog` (dedupes menu items on `(restaurant_id, source, external_id)`, returns the external→internal id map for FK linkage), `upsertOrders` (batch-inserts new orders + line items, deduped by external id, with a serial fallback for sources lacking one), `refreshDailySummaries` (source-agnostic 30-day rebuild — this is *why* DoorDash data automatically reaches margins/insights/alerts), and `runAlerts` (fire-and-forget alert regeneration). Keeping these here is what guarantees both channels dedupe, link, and aggregate *identically*.

### DoorDash integration

- **`restaurantiq-backend/src/services/doordash/doordashClient.ts`** — NEW. The vendor client, modeled on `squareClient.ts`: a factory taking a per-restaurant access token + store id, exposing `fetchCatalog()` and `fetchOrders()`. In mock mode it returns deterministic sandbox data with **stable external ids** (so re-syncs are idempotent and actually exercise the dedup path). Also houses `refreshAccessToken()` — the DoorDash OAuth2 `refresh_token` grant.
- **`restaurantiq-backend/src/services/doordash/normalizers.ts`** — NEW. Maps DoorDash's catalog/order JSON onto the shared `MenuItemRow` / `NormalizedOrder` shapes, stamping `source: 'doordash'`. Cost is unknown to DoorDash (set to `0`, filled in later via the Week 7 manual-cost UI). Notable detail: order total prefers the vendor's stated total but **falls back to summing the lines** so a missing total never silently zeroes out channel revenue.
- **`restaurantiq-backend/src/services/doordash/ingestDoorDash.ts`** — NEW. The DoorDash ingestion entry point — structurally a mirror of `ingestSquare.ts`. Loads creds, ensures a fresh token, fetches catalog→`upsertCatalog`, fetches orders→`upsertOrders`, then `refreshDailySummaries` + `runAlerts`. The first three steps are vendor-specific; the last two are the shared layer.
- **`restaurantiq-backend/src/routes/integrations/doordash.ts`** — NEW. Four routes mirroring Square's: unauthenticated `GET /status` (mode/environment probe), and authenticated `POST /connect` (persists store id + AES-GCM-encrypted access/refresh tokens), `POST /disconnect` (clears creds, *keeps* historical orders), and `POST /sync` (ownership check + a 60s `Promise.race` timeout envelope, returning 504 on timeout vs 500 on failure).
- **`restaurantiq-backend/src/scripts/seedDoorDashSandbox.ts`** — NEW. A seeder for the DoorDash sandbox, wired to `npm run seed:doordash`.

### Token refresh + encryption rotation

- **`restaurantiq-backend/src/lib/tokenCrypto.ts`** — UPDATED. Was a single-key AES-256-GCM encrypt/decrypt. Now supports **key rotation**: `encryptToken` always uses the *active* key; `decryptTokenWithMeta` tries the active key first, then each legacy key in order, and reports `usedActiveKey` so callers can re-encrypt forward. Backward compatible — the stored `iv:authTag:ciphertext` format is unchanged, and it falls back to the historical `TOKEN_ENCRYPTION_KEY` when `ACTIVE_TOKEN_ENCRYPTION_KEY` is unset.
- **`restaurantiq-backend/src/services/square/squareClient.ts`** — UPDATED. Adds `refreshAccessToken()` — the Square OAuth2 `refresh_token` grant against the OAuth base URL, returning the new access token, (optionally rotated) refresh token, and expiry. Returns `null` (not throw) on every failure mode so callers decide policy.
- **`restaurantiq-backend/src/services/square/ingestSquare.ts`** — UPDATED + SHRUNK. Lost ~180 lines: the catalog/order/summary write logic moved to the shared `persistence.ts`. Gained `ensureFreshSquareToken()` — decrypt the stored token (noting if it used a legacy key), refresh if expired/near-expiry, persist the new creds encrypted, and **opportunistically migrate legacy ciphertext forward** even when no refresh is needed. On refresh failure it marks the integration `pos_connected = false` and throws, so the sync returns a clean status instead of hammering Square with a dead token.
- **`restaurantiq-backend/src/services/square/normalizers.ts`** — UPDATED. Re-pointed at the shared `services/ingestion/types` row shapes so Square and DoorDash emit the identical structures the shared persistence layer consumes.
- **`restaurantiq-backend/migrations/016_doordash_integration.sql`** — NEW. Adds `doordash_access_token`, `doordash_refresh_token`, `doordash_token_expires_at` to `restaurants` (all nullable, `IF NOT EXISTS`, idempotent). `orders.source`/`menu_items.source` already permitted `'doordash'`, so no CHECK changes.
- **`restaurantiq-backend/migrations/017_square_token_refresh.sql`** — NEW. Adds `square_refresh_token` + `square_token_expires_at`, mirroring 016 for Square.

### Security hardening

- **`restaurantiq-backend/src/controllers/restaurantController.ts`** — UPDATED. Closed the raw-`error.message` leak in the three read/update handlers (`getMyRestaurant`, `getRestaurant`, `updateRestaurant`) to match the `createRestaurant` pattern from last sprint: log the real error server-side, return a generic client message. All four handlers are now consistent.

### Tests + tooling

- **`restaurantiq-backend/jest.config.js`** — NEW. `ts-jest` preset, `node` env, `**/__tests__/**/*.test.ts`, `clearMocks: true`. Two project-specific touches: a `testPathIgnorePatterns` entry for macOS AppleDouble `._*` files (this repo lives on a non-APFS volume), and `diagnostics: false` so test mocks don't need full typing.
- **`restaurantiq-backend/src/lib/__tests__/tokenCrypto.test.ts`** — NEW. Key-rotation round-trips, legacy-key decryption + migration flag, multi-legacy-key ordering, controlled error when no key matches, malformed-ciphertext rejection, and `decryptTokenSafe` leniency.
- **`restaurantiq-backend/src/services/square/__tests__/squareClient.test.ts`** — NEW. `refreshAccessToken` across mock mode, missing token, missing app creds, success, non-OK status, and a response missing the access token.
- **`restaurantiq-backend/src/services/square/__tests__/ensureFreshSquareToken.test.ts`** — NEW. The refresh decision tree end-to-end: no-refresh-when-valid, refresh-when-expired (and persist), refresh-within-window, refresh-token preservation when Square omits a rotated one, disconnect-and-throw on refresh failure, disconnect when no refresh token exists, and legacy-ciphertext migration on a valid read.
- **`restaurantiq-backend/src/controllers/__tests__/restaurantController.test.ts`** — NEW. `createRestaurant` happy path, 409 on Postgres `23505`, 409 on the pre-insert existence check, the generic-500-without-leak assertion, and 401 when the token carries no user id.

---

## The core design idea: a narrow waist, with `source` as the only variable

This is the thread that runs through the whole sprint. Internalize it and the file list reads itself.

The ingestion pipeline is shaped like an **hourglass** (a "narrow waist"):

```
  Square API          DoorDash API         (future: Uber Eats…)
      │                     │                      │
 squareClient          doordashClient         …client
      │                     │                      │
 square/normalizers   doordash/normalizers    …normalizers
      │                     │                      │
      └──────────┬──────────┴──────────────────────┘
                 ▼
   services/ingestion/types.ts   ← THE WAIST: MenuItemRow, NormalizedOrder, OrderSource
                 ▼
   services/ingestion/persistence.ts   ← upsertCatalog / upsertOrders / refreshDailySummaries / runAlerts
                 ▼
        orders · order_items · menu_items · daily_summaries
                 ▼
        margins · insights · alerts  (all source-agnostic, unchanged)
```

Above the waist, each vendor is messy and different — different JSON, different auth, different endpoints. Below the waist, everything is uniform: one set of row shapes, one write path, one aggregation. The **only** thing that varies across the waist is the `source` tag, and it varies for exactly two reasons:

1. **Dedup scoping.** `upsertCatalog` and `upsertOrders` match on `(restaurant_id, source, external_id)`. Scoping by `source` means two channels can never collide on each other's external ids — DoorDash item `dd-item-burger` and a hypothetical Square item with the same string are distinct rows.
2. **Attribution.** Every row is stamped with its `source` so downstream analytics can say "this revenue came from delivery vs. POS."

The payoff is concentrated in one function: **`refreshDailySummaries` is deliberately source-agnostic.** It aggregates *every* order for the restaurant regardless of channel. So the moment DoorDash orders land in the `orders` table, they flow into `daily_summaries` — and therefore into margins, insights, and alerts — with **zero changes to any of those features.** Adding a whole second revenue channel touched none of the analytics code. That's the narrow waist paying rent.

The general principle: **find the smallest interface that all your sources can agree on, force everything through it, and make the per-source variation a single parameter.** The cost is the discipline of designing the row shapes well; the reward is that source N+1 is a normalizer and a client, not a new pipeline.

---

## Deep dive: idempotent re-syncs, and why mock data has stable ids

A `/sync` you can safely run twice is the whole game in ingestion — networks retry, users double-click, cron overlaps. The pipeline achieves **idempotency** through dedup keys, and the mock data is deliberately built to *exercise* that path.

In `doordashClient.ts`, the sandbox catalog uses fixed ids (`dd-item-burger`, …) and orders use deterministic ids (`dd-order-${day}-${n}`). The header comment spells out why:

> Deterministic means stable external ids, so re-running /sync is idempotent (the shared persistence layer dedupes on external_id) — which also exercises the real dedup path.

Here's the mechanism in `upsertOrders` (`persistence.ts:93–108`): before inserting, it does **one** `SELECT` for which external ids already exist, filters those out, and inserts only the genuinely new ones:

```ts
const existingExternalIds = new Set<string>();
// ... SELECT external_id WHERE restaurant_id=? AND source=? AND external_id IN (...)
const newWithId = withId.filter((o) => !existingExternalIds.has(o.order.external_id!));
```

So the *first* sync inserts 12 orders; the *second* sync finds all 12 already present and inserts zero. Revenue doesn't double. And because the mock ids are stable rather than random, the second run actually hits the "already exists" branch — if the mock used `randomUUID()`, every sync would look new and the dedup code would never be tested by a demo. **The test data is designed to take the dangerous path, not avoid it.**

One subtlety worth flagging: `upsertCatalog` re-reads the menu items with a fresh `SELECT` after upserting, rather than trusting the upsert's `returning` clause. The comment explains the trap: when a row is unchanged, some PostgREST configs omit it from the returned set, leaving the external→internal id map sparse — which would silently break order-item linkage on the next sync. Reading back is the reliable way to build the FK map.

---

## Deep dive: the token-refresh decision tree (`ensureFreshSquareToken`)

This is the most behavior-dense function in the sprint, and the test file enumerates its branches one-for-one. Walk the decision tree in `ingestSquare.ts`:

### 1. Decrypt, noting whether a legacy key was used

```ts
const meta = decryptTokenWithMeta(restaurant.square_access_token);
currentAccess = meta.plaintext;
accessNeedsReEncrypt = !meta.usedActiveKey;   // stored under an old key?
```

### 2. Is the token expired — with a safety window?

```ts
const expired = expiresAt !== null && expiresAt - SQUARE_TOKEN_EXPIRY_WINDOW_MS <= Date.now();
```

The 5-minute window (`SQUARE_TOKEN_EXPIRY_WINDOW_MS`) is the important detail: we refresh a token that's *about* to die, not one that's already dead. Without the buffer, a token valid for 30 more seconds would be handed to a sync that takes 60 — and die mid-flight. (DoorDash's `ensureFreshToken` uses the same idea with a 60s skew buffer.) **Refresh proactively, with margin, because the work you're about to do takes time.**

### 3a. Not expired → return it, but migrate ciphertext opportunistically

```ts
if (!expired) {
  if (accessNeedsReEncrypt && currentAccess) {
    await supabase.from('restaurants')
      .update({ square_access_token: encryptToken(currentAccess) })  // re-encrypt under ACTIVE key
      .eq('id', restaurant.id);
  }
  return currentAccess;
}
```

Even on the happy path, if the token was stored under a retired key, we re-encrypt it forward. This is how a key rotation *completes itself over time* — every read of a legacy-encrypted value migrates it, so eventually no ciphertext under the old key remains and the old key can be deleted. No batch migration job required.

### 3b. Expired → refresh, persist, and on failure disconnect

```ts
const refreshed = await refreshAccessToken(refreshToken);
if (!refreshed) {
  await supabase.from('restaurants').update({ pos_connected: false }).eq('id', restaurant.id);
  throw new Error('...disconnected...');
}
// persist new access + (rotated-or-preserved) refresh + new expiry, encrypted
```

Two decisions encoded here, both tested:

- **Refresh-token preservation.** Square sometimes returns a rotated refresh token and sometimes doesn't. The code keeps the old one when none comes back (`squareClient` returns `refreshToken: json.refresh_token ?? null`, and the persist step falls back to the stored value). The test `preserves the existing refresh token when Square omits a rotated one` locks this in — lose it and the *next* refresh has no token and the integration silently dies a month later.
- **Fail loud, fail disconnected.** When refresh is impossible (no refresh token, or Square rejects it), we flip `pos_connected = false` and throw. The alternative — returning the dead token and letting the API 401 — would retry a doomed call and leave the UI claiming "connected." Marking it disconnected makes the failure visible and actionable: the operator reconnects.

The lesson: **a token-refresh routine is a small state machine, and its failure modes are the spec.** The tests aren't testing "does it refresh" — they're testing *every* branch of "what do we do when we can't."

---

## Deep dive: encryption-key rotation without a flag day

`tokenCrypto.ts` answers a question every system storing secrets eventually faces: *how do you retire an encryption key without making every existing ciphertext unreadable?*

The naive single-key design (what this file was last week) has a brutal failure mode: rotate the key and every stored token instantly becomes garbage, because GCM authentication fails under the wrong key. You'd need a synchronized migration of every row at the exact moment of rotation — a flag day.

The rotation design splits the key into roles:

- **`ACTIVE_TOKEN_ENCRYPTION_KEY`** — used to encrypt *all* new values.
- **`LEGACY_TOKEN_ENCRYPTION_KEYS`** — a comma-separated list of retired keys, used for **decryption only.**

`decryptTokenWithMeta` tries the active key, then each legacy key in order, and reports which one worked:

```ts
const fromActive = tryDecrypt(active, iv, authTag, ciphertext);
if (fromActive !== null) return { plaintext: fromActive, usedActiveKey: true };
for (const legacy of getLegacyKeys()) {
  const fromLegacy = tryDecrypt(legacy, iv, authTag, ciphertext);
  if (fromLegacy !== null) return { plaintext: fromLegacy, usedActiveKey: false };  // ← migrate me
}
throw new Error('Unable to decrypt token: no configured key matched');
```

The elegant part is **how `tryDecrypt` distinguishes "wrong key" from "right key"**: AES-GCM is *authenticated* encryption, so the wrong key makes `decipher.final()` throw (the auth tag won't verify). `tryDecrypt` catches that and returns `null`, letting the loop fall through to the next key. The auth tag isn't just integrity protection — here it's the signal that drives key selection.

`usedActiveKey: false` is the migration trigger. Any caller that decrypts with a legacy key knows it should re-encrypt and persist (which `ensureFreshSquareToken` does, above). So rotation is a **gradual, self-completing** process:

1. Move the current key into `LEGACY_TOKEN_ENCRYPTION_KEYS`, set a new `ACTIVE_TOKEN_ENCRYPTION_KEY`.
2. Everything keeps decrypting (active fails, legacy succeeds).
3. Every read migrates that value forward to the active key.
4. Eventually nothing uses the legacy key; delete it.

No flag day, no big-bang migration, no downtime. The backward-compat fallback (`?? process.env.TOKEN_ENCRYPTION_KEY`) means this rolled out without touching the existing env at all.

---

## Patterns and concepts you used (mechanics → CS concepts)

- **The narrow waist / hourglass architecture.** Many sources fan into one minimal interface (`ingestion/types`), which fans out to one implementation (`persistence`). The same shape that lets IP carry any protocol over any link lets this pipeline carry any vendor into any analytic.
- **Idempotency via dedup keys.** `(restaurant_id, source, external_id)` makes re-running a sync a safe no-op. This is the same idea as an idempotency key on a payment API — the operation's identity is in the data, not the request count.
- **Adapter pattern.** Each `*/normalizers.ts` is an adapter translating a vendor's interface into the shared row shapes. New vendor = new adapter, nothing downstream changes.
- **Refactor-by-extraction under test.** Square's proven logic was lifted verbatim + parametrized, with a test suite written to pin the behavior. The change you reason about is "+1 parameter," not "rewrote ingestion."
- **Proactive token refresh with a skew window.** Refresh before expiry (5 min / 60 s buffers) because the work you're about to do takes time and clocks drift. A reactive "refresh on 401" alone races the very call that needs the token.
- **Key rotation with versioned/era keys.** Active-for-write, legacy-for-read, migrate-on-touch. The standard answer to "rotate a key without re-encrypting the world at once."
- **Authenticated encryption (AES-256-GCM) as a control-flow signal.** The auth tag failing under the wrong key is what lets multi-key decryption try keys in turn and know which succeeded.
- **Fail-closed on integration health.** A token that can't refresh flips `pos_connected = false` and throws, rather than returning a dead credential. The failure is surfaced, not buried.
- **Fire-and-forget for non-critical side effects.** `runAlerts` swallows its own errors so alert generation can never fail a sync. Knowing which steps are load-bearing (writes) and which are best-effort (alerts) is a real design call.
- **Defense in depth, restated.** `/sync`'s ownership check (`.eq('user_id', userId)`) plus tenant-scoped writes; the controller's log-internally / return-generic error handling. Same trust-boundary discipline as prior sprints, now applied to a second channel.

---

## Bugs caught / fixed during the sprint

### The raw `error.message` leak in three restaurant handlers (the session opener)

Last sprint's hardening scoped the error-leak fix to `createRestaurant` per its spec, leaving `getMyRestaurant`, `getRestaurant`, and `updateRestaurant` still returning `error: error.message` on a 500 — handing raw Supabase/Postgres internals (column names, constraint names, driver strings) straight to the client. That's an information-disclosure leak: error text is reconnaissance for an attacker and noise for a user. Fixed by applying the established pattern to all three — `console.error('[restaurants] … failed', error)` server-side, generic message to the client. The lesson: **a leak fixed in one handler is a leak still open in its three siblings** — error handling is a per-boundary property, and "scope it to the one the spec named" leaves a class of bug half-closed. `createRestaurant`'s own generic-500 behavior is now regression-tested (`returns a generic 500 ... without leaking details`).

### Missing-total fallback in the DoorDash normalizer

A DoorDash order could arrive without a stated `total`. Naively trusting `order.total` would zero out that order's revenue — a silent under-count of channel revenue, the worst kind because nothing errors. The normalizer falls back to summing the line items: `order.total !== undefined ? toCents(order.total) : lineTotal`. The general lesson, same as Week 7's `null`-isn't-`0` rule: **for money, a missing input should be reconstructed or refused, never silently treated as zero.**

### The sparse-map trap in catalog upsert (inherited, preserved)

Not introduced this sprint, but worth understanding because the extraction *preserved* it deliberately: `upsertCatalog` re-reads menu items with a fresh `SELECT` instead of trusting the upsert's `returning` clause, because PostgREST may omit unchanged rows from the returned set — which would leave the external→internal id map sparse and silently break order-item linkage. When extracting shared code, this kind of hard-won workaround is exactly what you must carry over *verbatim*; "cleaning it up" would reintroduce the bug.

---

## What you should be able to explain in an interview

**"You added a second order source. How did you avoid duplicating your ingestion code, and why does that matter?"**
I extracted the write path — dedup, order-item linkage, daily-summary rebuild, alert regeneration — out of the Square-specific file into a shared `services/ingestion/persistence` layer that takes the source as a parameter. Both Square and DoorDash became thin "fetch from the vendor, normalize to shared row shapes, hand off to persistence" front-ends. It matters because that logic is subtle — the dedup keys, the FK-map reconstruction — and two copies would drift; a fix in one wouldn't reach the other. It's the difference between supporting two channels and supporting N: the next source is a client plus a normalizer, not a new pipeline. And critically, the daily-summary rebuild is source-agnostic, so DoorDash data reached margins, insights, and alerts with zero changes to any of those features.

**"How do you make a sync safe to run twice?"**
Idempotency through dedup keys. Every menu item and order carries the vendor's own id as `external_id`, and I dedupe on `(restaurant_id, source, external_id)`. Before inserting orders I do one SELECT for which external ids already exist and insert only the new ones, so a second sync inserts zero rows and revenue doesn't double. I even made the mock sandbox data use *stable* ids rather than random ones, specifically so a demo re-sync exercises the dedup path instead of looking like all-new data every time.

**"Walk me through what happens when an access token expires mid-integration."**
Before each sync I check expiry with a safety window — 5 minutes for Square — so I refresh a token that's *about* to expire, not one that just did, because the sync itself takes time. If it's within the window, I call the OAuth refresh-token grant, persist the new access token, expiry, and refresh token (preserving the old refresh token if the provider didn't rotate one — losing that would silently kill the integration next cycle), all encrypted at rest, then continue. If refresh is impossible — no refresh token or the provider rejects it — I mark the integration disconnected and throw, so the operator sees an actionable state instead of the app retrying a dead token and still claiming "connected."

**"How do you rotate an encryption key without re-encrypting everything at once?"**
I split the key into an active key used for all new encryption and a list of legacy keys used only for decryption. Decryption tries the active key, then each legacy key in order; AES-GCM is authenticated, so the wrong key throws on the auth-tag check and I just fall through to the next. When a value decrypts under a legacy key, I flag it, and the caller re-encrypts and persists it under the active key. So rotation completes gradually as values are touched — no flag day, no big-bang migration. To retire a key you move it to legacy, let reads migrate values forward over time, then delete it once nothing uses it.

**"Why does the wrong decryption key 'just throw' — how do you know it's wrong rather than the data being corrupt?"**
AES-GCM is authenticated encryption. Each ciphertext carries an auth tag computed over the plaintext and key. On decrypt, `final()` recomputes and verifies it; under the wrong key the tag won't match and it throws. I can't distinguish "wrong key" from "tampered ciphertext" from the exception alone — both fail authentication — but for key *selection* that's fine: any failure means "not this key, try the next," and if no configured key works I throw a controlled error. The auth tag is doing double duty: integrity protection and key-selection signal.

**"You moved proven code into a shared module. How did you keep that safe?"**
I lifted it verbatim and made the source a parameter — the only delta — rather than rewriting it, so I'm reasoning about one small change instead of a reimplementation. I preserved even the non-obvious workarounds, like re-reading the catalog after upsert instead of trusting the returning clause, because those encode real bugs. And I wrote the test suite around the highest-risk behaviors — token refresh branches, key rotation, the error-leak fix — so the extraction is pinned by tests, not just by inspection.

---

## What to look up if you want to go deeper

- **The "narrow waist" / hourglass model** (e.g. the IP hourglass, or "On the Hourglass Model" by Beck, CACM 2019) — the formal argument for why a single thin interface in the middle maximizes both the diversity of things above it and below it. Your ingestion pipeline is a small instance of the same idea.
- **Idempotency keys** (Stripe's API idempotency docs are the canonical practical writeup) — the general pattern of putting an operation's identity in the data so retries are safe. Your `external_id` dedup is this applied to ingestion.
- **AES-GCM and authenticated encryption (AEAD)** (NIST SP 800-38D; the "Cryptographic Doom Principle") — why GCM gives you confidentiality *and* integrity in one pass, why the auth tag matters, and why you must never reuse an IV under the same key (you use a random 12-byte IV per encryption — look up why 96 bits is the recommended GCM nonce size).
- **Envelope encryption & key rotation** (AWS KMS "envelope encryption" docs; the concept of a key hierarchy / key versioning) — the production-grade version of your active/legacy-key scheme, where a key-encryption-key wraps per-record data keys so rotation is even cheaper.
- **OAuth 2.0 refresh tokens and rotation** (RFC 6749 §6, plus the OAuth 2.0 Security Best Current Practice on refresh-token rotation) — the spec behind the refresh grant and why providers rotate refresh tokens, which is exactly the case your "preserve the old one if none returned" code handles.
- **The Adapter pattern** (Gang of Four) — the formal name for what your per-vendor normalizers are: translating an incompatible interface into the one your system expects.
- **ts-jest and testing TypeScript** (ts-jest docs) — how `preset: 'ts-jest'` compiles tests on the fly, what `diagnostics: false` trades away (type errors in tests become runtime, not compile, failures), and `jest.requireActual` for partially mocking a module (used in the Square refresh tests to mock only the network call).

---

## Things punted (technical debt with names)

- **DoorDash live mode is unverified against the real API.** The live `fetchCatalog`/`fetchOrders` paths target plausible Marketplace endpoints (`/marketplace/api/v1/stores/:id/menu|orders`) and tolerant response shapes (`json.items ?? json.data ?? []`), but DoorDash's real order/menu APIs are partner-gated and haven't been exercised. Everything proven end-to-end runs through mock mode. Named follow-up: validate against sandbox credentials and pin the real response shapes.
- **No DoorDash-side tests.** The Jest suite covers token crypto, the Square refresh flow, and the restaurant controller — but the DoorDash client, normalizers, and ingest entry point have no direct tests yet. They mirror Square structurally, but "mirrors a tested thing" isn't "tested." Add a DoorDash normalizer + ingest suite.
- **The shared `persistence.ts` itself is untested in isolation.** Its behavior is exercised indirectly, but the dedup/linkage/summary logic — the most consequential code in the pipeline — deserves its own unit tests now that it's a shared module, not Square-internal.
- **No automatic key-rotation tooling.** Rotation works (active/legacy keys, migrate-on-read), but there's no command to *generate* a new key, no report of "how many ciphertexts still use a legacy key," and no way to force-migrate the stragglers so a legacy key can finally be deleted. Migration completes only as values happen to be read.
- **`refreshDailySummaries` recomputes the full 30-day window every sync.** Correct and simple, but O(orders in 30 days) on every sync regardless of how few orders are new. Fine at current scale; an incremental "only recompute touched dates" version is the eventual optimization.
- **DoorDash mock mode is gated by the same global `USE_MOCK` as Square.** You can't currently run Square live and DoorDash mock (or vice versa) in the same process — it's all-or-nothing. A per-source mock flag would make mixed-mode local testing possible.
- **`disconnect` leaves orphaned historical orders.** Disconnecting DoorDash clears credentials but intentionally keeps past orders/summaries (so analytics history survives). That's a defensible choice, but there's no UI signal that a chunk of the dashboard's data comes from a now-disconnected source, and no way to purge it if an operator wants to. Name it: "disconnected-source data provenance."
