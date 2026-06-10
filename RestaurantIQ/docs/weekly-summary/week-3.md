# Week 3 — Square Integration, Real Auth, Live Dashboard

> Teaching summary. Read it once now to lock in what you built; read it again before any interview where you might describe this project.

---

## Sprint goal in one sentence

Replace the mock dashboard with a real backend pipeline that pulls live data from a POS (Square), and harden authentication so the API actually trusts the tokens it's handed.

## What shipped, in plain English

1. **The dashboard is no longer fake.** It calls a real endpoint, which queries Postgres, computes 30-day revenue and a 14-vs-14 trend per item, and renders it.
2. **API requests are properly authenticated.** The middleware verifies Supabase's modern asymmetric JWTs by fetching a public key set, instead of relying on a shared secret.
3. **Square is wired in end to end.** A migration renamed `toast_guid` → `square_location_id`, the Square Node SDK is integrated, and there's an ingestion pipeline that pulls catalog + orders and rebuilds daily summaries.
4. **A `.gitignore` exists** so secrets don't end up on GitHub.

---

## File-by-file: what it is, why it exists

### Backend

**`migrations/002_square_integration.sql`** — A forward SQL migration. Renames the Toast column on `restaurants`, adds `square_access_token`, and replaces the `menu_items.source` CHECK constraint with one that accepts `'square'`. *Why a numbered migration file:* schema changes need to be reproducible; you can't just edit Supabase's UI and forget how you got there. Every developer / environment runs the same SQL in order.

**`src/middleware/auth.ts`** — Express middleware that validates the `Authorization: Bearer <jwt>` header before any protected route runs. Tries asymmetric verification (ES256 via JWKS) first, falls back to HS256 with a shared secret. Sets `req.user = payload` on success.

**`src/services/square/squareClient.ts`** — A factory that returns a configured `Square` SDK client. Reads `SQUARE_ENVIRONMENT` (sandbox vs production) and accepts a per-restaurant access token, falling back to `SQUARE_ACCESS_TOKEN` env. Also exports an `isMockMode()` helper that other services check before doing real I/O.

**`src/services/square/normalizers.ts`** — Pure functions that map Square's response shapes onto our internal row shapes:
- `normalizeCatalogItem(squareItem)` → `menu_items` row
- `normalizeOrder(squareOrder)` → `{ order, items[] }`
- `normalizePayment(squarePayment)` → `orders` row (legacy fallback)

These functions are **pure** — same input always produces same output, no side effects, no I/O. That makes them trivial to unit test and easy to reason about.

**`src/services/square/ingestSquare.ts`** — The orchestration layer. Loads a restaurant's Square credentials, paginates through Square's Catalog and Orders APIs, hands each response to a normalizer, upserts the result into Supabase, and finally rebuilds `daily_summaries` for the trailing 30 days.

**`src/routes/integrations/square.ts`** — Three HTTP handlers wrapping the service:
- `POST /connect` — saves location ID + access token onto a restaurant row
- `POST /sync` — fires the ingestion pipeline
- `GET /status` — health probe (returns mock mode + environment, no credentials)

**`src/routes/menuItems.ts`** *(modified)* — Now auth-gated and joins `daily_summaries` to compute `revenue_30d_cents`, `orders_30d`, and a `trend` ('up'/'down'/'flat') by comparing the last 14 days to the prior 14.

**`.env.example`** — A documented template of every env variable the backend reads. Committed; the actual `.env` is not.

### Frontend

**`src/components/MenuItemsTable.tsx`** *(rewritten)* — Replaces the static `MOCK_ITEMS` array with a `useEffect` that fetches `/api/restaurants/:id/menu-items` using the Supabase session's access token. Renders three explicit states: loading, error, empty.

**`src/pages/Onboarding.tsx`** *(fixed)* — Was calling `user?.getIdToken()`, a Firebase API. Switched to `session.access_token` from the Supabase auth context.

**`src/components/auth/AuthContext.tsx`** *(fixed)* — Bad relative import path (`../lib/supabase`) corrected to `../../lib/supabase`.

**`vite.config.ts`** *(modified)* — Added a dev proxy: any `/api/*` request from the Vite dev server forwards to `http://localhost:3001`. This is what makes `fetch('/api/...')` "just work" in development without CORS gymnastics.

### Repo root

**`.gitignore`** — Ignores `.env`, `node_modules`, build outputs, IDE folders, macOS metadata (`._*`, `.DS_Store`), and Vite cache.

---

## Key technical decisions

### 1. Switched JWT verification from HS256 to JWKS

**Context:** Supabase has two eras of JWT signing. The legacy approach uses **HS256** — a symmetric algorithm where the same secret signs and verifies tokens. Modern Supabase projects use **ES256** — an asymmetric algorithm where the auth server signs with a private key and clients verify with a public key.

**Decision:** Use the `jose` library with `createRemoteJWKSet` to fetch the project's public key set from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, and verify each incoming JWT against it. Keep an HS256 fallback for older projects.

**Why:** With ES256, the server only needs the **public key** to verify — there's no shared secret to leak. The JWKS endpoint exposes the public keys (safe), and clients fetch them on first request and cache them. If Supabase rotates keys, JWKS reflects the change automatically; with HS256 you'd be redeploying with a new secret.

**Subtle bug we hit:** The middleware tried to read `SUPABASE_URL` at module-load time, but `dotenv.config()` ran in `server.ts` *after* the imports finished. Node imports are evaluated top-down, eagerly, so `process.env.SUPABASE_URL` was `undefined` when the middleware initialized. Fix: lazy-evaluate the JWKS URL on first request, after env is populated. **Lesson: code that reads `process.env` at module init time is fragile; prefer reading at use time.**

### 2. Stored Square credentials per-restaurant

The cleanest production design is one access token per merchant, scoped to their account. So `restaurants.square_access_token` holds the token, and `getSquareClient({ accessToken })` is called per-request. The `SQUARE_ACCESS_TOKEN` env var is just a developer convenience for local testing.

**Caveat we left in:** the token is plaintext in Postgres. Production should encrypt it at rest (e.g., Supabase Vault or pgcrypto with a key in your secret manager). Noted in the migration comment.

### 3. Pure normalizers, side-effecting ingestor

The normalizer functions never touch the database. The ingestor pulls data, calls normalizers, and writes results. This separation means:
- Normalizers are unit-testable with no fixtures (just pass an object, assert on output)
- The ingestor's logic is **only** about pagination, ordering, and persistence
- If Square ever changes a response shape, only normalizers change

This is one slice of a broader pattern — keeping pure logic separate from I/O — and it's worth internalizing.

### 4. Numbered SQL migrations instead of "fix it in the dashboard"

`migrations/002_square_integration.sql` is a forward-only SQL file you run by hand in the Supabase SQL editor. Not yet automated, but the file itself is the source of truth. **Why this matters:** if you blow away the database and re-create it, running the migrations in order gives you the exact same schema. Editing in the Supabase dashboard breaks that property — a teammate (or future-you) has no way to reproduce the schema state.

### 5. Vite dev proxy instead of CORS

In development, the frontend runs on port 5173 and the backend on 3001. A request from one origin to another is **cross-origin** and would normally be blocked by the browser unless the backend sends the right CORS headers. We could configure CORS, but a cleaner dev experience: tell Vite "any request to `/api/*`, forward to `localhost:3001` server-side." The browser only sees same-origin requests; no CORS headers needed in dev. In production, the frontend and backend live behind a single domain, so this concern disappears entirely.

### 6. Money as integer cents — everywhere

Square returns `Money { amount: bigint, currency: 'USD' }` where `amount` is the smallest currency unit (cents for USD). We coerce `bigint → number` because Postgres `integer` columns can't hold BigInt via the Supabase JS driver, and our amounts comfortably fit in 32 bits.

**Why never floats:** `0.1 + 0.2 !== 0.3` in IEEE-754. If you sum a million order totals stored as floats, you'll be off by pennies — and accountants will notice. Storing `1099` cents instead of `10.99` dollars sidesteps the entire class of bugs. Format for display only.

---

## Patterns and concepts you used

### Repository / service / route layering
- **Route handlers** (`routes/integrations/square.ts`) parse HTTP, return JSON
- **Services** (`services/square/ingestSquare.ts`) hold business logic
- **Pure helpers** (`services/square/normalizers.ts`) transform data

This is a lightweight version of "hexagonal architecture" or "clean architecture." The point: HTTP concerns shouldn't leak into business logic, and business logic shouldn't leak into data transformation.

### Public-key cryptography (asymmetric crypto)
ES256 = ECDSA (Elliptic Curve Digital Signature Algorithm) over the P-256 curve, using SHA-256. The auth server holds a private key; verifiers hold the public key. Anyone can verify, only the auth server can sign. JWKS is just a JSON-formatted way to publish those public keys.

### JWT structure
A JWT is three Base64URL-encoded chunks separated by dots: `header.payload.signature`. The `header` says which algorithm and which key (`kid`). The `payload` has claims (`sub`, `iat`, `exp`, etc.). The `signature` is the HMAC (HS256) or signature (ES256) of `base64(header).base64(payload)`. Decoding is trivial; **verifying** requires the secret/public key. Never trust the payload until you've verified the signature.

### Pagination via cursors
Square's APIs return a `cursor` string when there are more pages. You re-call the same endpoint passing that cursor until it stops returning one. **Why cursors instead of `?page=2`:** cursor pagination is stable under inserts (no skipped or duplicated rows) and doesn't get slower as you go deeper.

### Idempotent upserts
The catalog upsert checks if a row exists first (by `name` for now), then either updates or inserts. This means re-running `/sync` produces the same final state as running it once — **idempotent**. Idempotent operations are crucial for sync pipelines because retries are inevitable.

### Lazy initialization
The JWKS URL is computed on first request, not at module load. This pattern is useful any time a value depends on configuration that may not be ready yet. Same idea: lazy database connections, lazy file handles.

### Pre-aggregation for read performance
We don't compute 30-day revenue from raw `orders` on every dashboard page load. We pre-compute into `daily_summaries` once after each sync. Read queries become a `SUM` over ~30 small rows instead of potentially thousands. **Tradeoff:** writes are more complex and summaries can drift if a sync fails partway through.

---

## What you should be able to explain in an interview

After this sprint, you should be able to walk through any of these in 60–90 seconds without notes:

1. **"How does your authentication work?"**
   *"The frontend signs in via Supabase, gets a JWT. Every API request sends it as a Bearer token. The Express middleware grabs the project's public keys from Supabase's JWKS endpoint, verifies the JWT signature with `jose`, and attaches the decoded payload to `req.user` if it's valid. We also support legacy HS256 secrets as a fallback."*

2. **"Why JWKS instead of a shared secret?"**
   *"Asymmetric signing means only the auth server has the private key. The verifier only needs the public key, which is safe to expose. If Supabase rotates keys, JWKS reflects the change without redeploying. With a shared secret, key rotation is a coordinated outage."*

3. **"Walk me through the Square sync."**
   *"Express route → service. Service loads the restaurant's Square credentials, instantiates a Square client, paginates through Catalog API. Each item goes through a pure normalizer that maps Square's shape onto our `menu_items` row shape. We upsert by name (until we add a unique index on `external_id`). Same flow for Orders. Then we recompute `daily_summaries` for the last 30 days from raw orders."*

4. **"Why do you store money as integers?"**
   *"Floating-point arithmetic isn't associative — summing many small floats produces drift. Storing cents as integers gives you exact arithmetic. Postgres's `integer` type holds up to ~21 million dollars in cents, which is well past anything we'd see per-row."*

5. **"What's pre-aggregation and why use it here?"**
   *"Instead of computing revenue from raw orders on every read, we compute it once per day per item into a `daily_summaries` table. Reads become tiny range scans. The cost is making sure summaries stay correct — we rebuild the trailing 30-day window after each sync."*

6. **"What's the dev-environment proxy for?"**
   *"Frontend's on 5173, backend's on 3001. Cross-origin without CORS headers gets blocked. The Vite proxy forwards `/api/*` server-side so the browser only ever sees same-origin requests. Production uses a single domain so the issue disappears."*

---

## What to look up if you want to go deeper

- **JWT spec (RFC 7519)** — full grammar of claims, registered claim names, signing algorithms.
- **JWS (RFC 7515) and JWA (RFC 7518)** — how the signature is built, what algorithms are allowed.
- **JWKS / JWK (RFC 7517)** — exact format of the public key set.
- **`jose` library docs** — read the source of `createRemoteJWKSet` once. It's ~100 lines of cache + fetch.
- **OAuth 2.0 vs OIDC** — Supabase Auth is essentially OIDC. Worth understanding the larger context.
- **Square API docs**, especially:
  - Catalog API object model (items, variations, modifiers — we collapsed variations; revisit this when you support combos)
  - Webhooks — instead of polling via `/sync`, Square can push events to a webhook endpoint. Real production should use webhooks + occasional reconciliation polls.
- **Idempotency keys** — when you start writing back to Square (creating orders, refunds), you'll need to send `Idempotency-Key` headers so retries don't double-charge.
- **Postgres CHECK constraints + ENUM types** — you used a CHECK on `source`. Eventually you may want a real enum; trade-offs are interesting (enums are faster but harder to migrate).
- **Database migration tools** — `node-pg-migrate`, `kysely`, `drizzle-kit`, `prisma migrate`, `sqitch`. We're hand-running SQL files; eventually you'll want a tool that tracks which migrations have been applied per environment.
- **Pure functions, referential transparency** — the property that makes the normalizers testable. Worth understanding why functional patterns survive in otherwise imperative codebases.
- **Cursor pagination vs offset pagination** — search "Use The Index, Luke" by Markus Winand for the deep treatment.

---

## Things you punted (and should track)

- `restaurants` has no `user_id` — multi-tenant isolation is enforced by trust, not by the schema. Add a column + RLS policies before letting more than one user in.
- Square access tokens are plaintext. Encrypt before production.
- `menu_items` has no `external_id` unique index — upserts use `name` as a soft key. Brittle.
- `orders` similarly has no `external_id` — sync dedupes by `(ordered_at, total_cents)`, which is good enough for sandbox, fragile for real merchants.
- The Payments fallback is disabled because the Square SDK v37 mishandles `undefined` positional args. Re-enable behind `PAYMENTS_FALLBACK=true` once you fix the call signature.
- Onboarding submits to `POST /api/restaurant` but doesn't capture `req.user.sub` to link the row to the user.

These aren't bugs blocking the demo — they're **technical debt with names**, which is the right state to leave them in.
