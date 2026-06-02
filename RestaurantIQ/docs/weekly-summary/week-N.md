# Week N — Production Hardening, Security & Operations

## Sprint goal in one sentence
Take a working-but-naked Express API and make it *deployable to strangers*: one consistent error shape that never leaks internals, cost protection on the two endpoints that spend real money, security headers, structured logs you can actually grep, a tracked SQL migration runner to replace "paste into the Supabase editor," and the operational docs (deploy / backup / migrate) an on-call human needs — **with no new product features**, just the difference between a demo and a service.

## What shipped, in plain English
- Every error the API can produce now comes back in the same shape, and in production the user never sees a stack trace or a database internal — they get a clean message, while the full detail goes to the server logs.
- The two AI endpoints (insights, marketing copy) are now rate-limited *per user*, so one buggy or abusive client can't run up a surprise Anthropic bill for everyone.
- The backend now sets standard browser security headers (via helmet) and logs every request as a structured line you can feed to a log aggregator — without ever logging tokens or secrets.
- There's a real database migration tool now: `npm run migrate` applies the numbered SQL files in order, records what it ran, and refuses to run anything twice — replacing the old "copy-paste SQL into the Supabase dashboard" ritual.
- A `/health` endpoint exists for Railway and uptime monitors that answers instantly and never touches the database, so a slow database can't make the platform think the app is dead.
- Three operational docs landed — deploy runbook, backup/disaster-recovery, and the migration workflow — written so an operator with zero prior context can act during an incident.

## File-by-file

### `restaurantiq-backend/src/middleware/errorHandler.ts` (new)
Three exports that together make error handling consistent and safe.

`ApiError` is a small `Error` subclass carrying an HTTP `status` and an `expose` boolean. You throw `new ApiError(404, 'Restaurant not found')` from anywhere and the handler renders it with the right status. The clever default: `expose` defaults to `status < 500` — 4xx messages describe a client mistake and are safe to send back; 5xx messages might leak internals and are hidden by default.

`notFoundHandler` is a normal (3-arg) handler mounted after every router. Any path that matched no route falls through to it and gets `{ data: null, error: 'Not found' }` with a 404 — instead of Express's default HTML `Cannot GET /whatever`, which would break a frontend that always expects JSON.

`errorHandler` is the final **4-argument** middleware (`err, req, res, next`). Express identifies error-handling middleware *by its arity* — it only routes errors to a function that declares four parameters. Drop `next` to "clean up an unused param" and Express silently treats it as a regular handler that never fires for errors. Three things it does worth understanding:
- **`res.headersSent` guard.** If the response already started streaming, you can't change the status or body, so it delegates to Express's built-in handler (`return next(err)`) to close the connection cleanly.
- **Always log the full error server-side** as a single JSON line to stderr (`event: REQUEST_ERROR`, with method, path, status, message, and stack), matching the scheduler's logging style. Operators get everything; the client gets nothing dangerous.
- **Decide what the client may see.** An `ApiError` honors its own `expose`; otherwise the rule is "expose if it's a 4xx, or if we're not in production." So in prod, a raw 500 becomes the generic `'Internal server error'`, but in dev you still see the real message to debug.

The header comment also records the contract decision (string `error`, not nested object) — see Key Decisions.

### `restaurantiq-backend/src/middleware/rateLimit.ts` (new)
Exports `createAiRateLimiter()`, a factory returning an `express-rate-limit` v8 limiter mounted only on the Claude-powered routers. Why a factory and not a module-level constant: it calls `loadEnv()` at *call time*, so the window/limit are read after env validation has run, consistent with the rest of the codebase's lazy-env pattern.

The load-bearing choice is `keyGenerator`. The limiter is mounted **after** `authMiddleware`, so `req.user.sub` (the Supabase user id) is available, and it keys the bucket on that user id rather than the client IP. Behind a shared proxy or corporate NAT (where many real users share one egress IP), IP-keying would let one heavy user exhaust the limit for everyone behind that IP — user-keying is fair. If the user id is somehow missing it falls back to `ipKeyGenerator(req.ip)` — not raw `req.ip`, because express-rate-limit v8 requires IPv6 addresses to be normalized to a subnet so a single client can't trivially rotate through a /64 to dodge the limit.

When the limit trips, the custom `handler` returns 429 in the project envelope (`{ data: null, error: '...' }`) instead of the library's default plaintext — so a rate-limit response parses exactly like every other error the frontend sees. It also advertises remaining quota via the standardized `RateLimit-*` headers (`standardHeaders: 'draft-7'`) and drops the legacy `X-RateLimit-*` ones.

### `restaurantiq-backend/src/middleware/requestLogger.ts` (new)
A `morgan`-based `RequestHandler` factory. In production it emits one JSON line per request (`event: HTTP_REQUEST`, method, route, status, response time in ms) so a log aggregator can parse fields without regex; in development it uses morgan's concise colorized `dev` format for humans. The function branches on `NODE_ENV` and returns one of two `morgan(...)` calls rather than passing a union format — morgan's string-format and function-format overloads are distinct signatures and a union confuses the types.

Two subtle correctness details:
- **It logs only method/URL/status/timing — never the `Authorization` header, cookies, or bodies.** Auth travels in the header (never the query string) in this API, so the chosen tokens are structurally incapable of leaking a secret. That's a design property, not just a promise.
- **The `skip` function reads `req.originalUrl`, not `req.url`.** Express mutates `req.url` to the mount-relative path while routing, so by the time morgan evaluates `skip`, `req.url` may no longer be `/health`. `originalUrl` is stable. Health checks fire constantly from the platform, so skipping them keeps the logs signal-rich.

Logs go to **stderr** (not morgan's default stdout) to sit alongside the scheduler and error JSON logs and to honor the project's "no stdout chatter" convention.

### `restaurantiq-backend/src/scripts/migrate.ts` (new — the ops centerpiece)
A self-contained migration runner using the `pg` dependency the scheduler already pulled in — no new tooling. It reads the numbered `migrations/*.sql` files, applies the pending ones in **filename order**, and records each in a `schema_migrations` table (`filename` PK, `checksum`, `applied_at`) so nothing runs twice.

Commands: `up` (apply pending — the default), `status` (list applied vs pending and flag drift), `baseline` (record all current files as applied **without executing them**). Plus `--dry-run` on any of them. The npm scripts are `migrate`, `migrate:status`, `migrate:baseline`.

The part worth studying is **atomicity** (`runUp`). Each migration is applied inside one transaction *together with* its tracking-row insert:
```
BEGIN → run migration SQL → INSERT INTO schema_migrations → COMMIT   (ROLLBACK on any error)
```
Either the schema change *and* the record that it happened both commit, or neither does — there's no window where a migration succeeds but the runner forgets it ran (which would re-run it next time) or where the record lands but the migration half-failed. The catch: the migration files themselves wrap their bodies in `BEGIN;`/`COMMIT;` (so they still work if pasted manually in an emergency). A nested `BEGIN` inside the runner's transaction would break the single-transaction guarantee, so `stripTxControl()` removes standalone `BEGIN;`/`COMMIT;` lines before executing — leaving exactly one transaction boundary, the runner's.

`baseline` exists for a specific real situation: production already had migrations 002–020 applied by hand before this runner existed, and several of them are *not* idempotent (e.g. a `RENAME COLUMN` that would error on a second run). Running `up` against that DB would try to re-execute them. `baseline` instead inserts tracking rows (`ON CONFLICT DO NOTHING`) without running anything, adopting the existing DB into the new system. You run it exactly once.

`status` recomputes each file's checksum and compares it to the stored one. A mismatch is **drift** — someone edited an already-applied migration — and the runner shouts about it, because the cardinal rule of forward-only migrations is *never edit an applied file; add a new one.* The checksum is the enforcement mechanism for that rule.

### `restaurantiq-backend/src/routes/health.ts` (modified)
Now returns a plain object — `{ status: 'ok', timestamp, version }` — **not** the `{ data, error }` envelope. That's deliberate: health checks are consumed by Railway and uptime monitors that want a dead-simple body, not by the frontend's envelope parser. `version` resolves once at module load from `APP_VERSION` (explicit override) → `npm_package_version` (set automatically by `npm start`) → `'unknown'`. Crucially it does **no database call and no auth** (see Key Decisions).

### `restaurantiq-backend/src/server.ts` (modified)
The wiring that activates everything above, in an order that matters:
- `import 'express-async-errors'` near the top, *before* routers are defined. This patches Express so a `throw` (or rejected promise) inside an `async` route handler reaches `errorHandler` instead of becoming an unhandled rejection (see Key Decisions for why Express 4 needs this).
- `helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })` first in the chain, then `cors`, then `requestLogger()`, then `express.json()`. Logger is mounted early so it observes every request.
- `/health` and `/api/health` are mounted **before** the API routers, so a health check never passes through auth or rate limiting.
- `notFoundHandler` then `errorHandler` are registered **last**, after every router — Express only routes an error to the 4-arg handler if it was raised by middleware/routes declared *above* it, so position is load-bearing, not stylistic.

### `restaurantiq-backend/src/routes/insights.ts` & `marketing.ts` (modified)
Each gained one line: `router.use(createAiRateLimiter())` immediately after `router.use(authMiddleware)`. Order is the whole point — auth runs first so the limiter can key on `req.user.sub`. These are the only two routers that call Anthropic, so they're the only two that need cost protection.

### `restaurantiq-backend/src/config/env.ts` (modified)
Added `RATE_LIMIT_WINDOW_MINUTES` (default 15), `RATE_LIMIT_MAX_REQUESTS` (default 50), and `APP_VERSION` (optional) to the Zod schema. They join the existing fail-fast validation: the process refuses to boot with a readable, aggregated error if anything required is missing, rather than dying later with an opaque `undefined`.

### `restaurantiq-backend/.env.example` (modified)
Documents the three new vars with inline notes, and clarifies that `NODE_ENV=production` is what flips on the production hardening behavior (locked CORS, hidden error internals).

### `docs/deployment.md`, `docs/operations.md`, `docs/migrations.md` (new / expanded)
The human runbooks. `deployment.md` is the end-to-end deploy (Railway backend + Vercel frontend), a pre-deploy config checklist, and a post-deploy smoke-test checklist that verifies each Sprint N feature live (health 200, 429 on rate limit, helmet headers present via `curl -sI`, CORS blocks unlisted origins). `operations.md` covers what needs protecting, Supabase automated backups vs. manual `pg_dump`, RPO/RTO, restore steps, and the **critical coupling**: a DB restore is useless for integration-token rows if the `ACTIVE_TOKEN_ENCRYPTION_KEY` is lost, so the key is backed up with the same rigor as the database. `migrations.md` is the workflow for the new runner — authoring, baseline-once, the expand→migrate→contract deploy ordering, and why rollback is forward-only (compensating migrations, or restore-from-backup for destructive changes).

## Key technical decisions

### Error shape: `error: "string"` over the brief's `error: { message }`
- **Context:** the sprint brief proposed `{ error: { message } }`. The existing API and frontend have always used `{ data, error }` where `error` is a *string* — the frontend reads `body.error` directly at ~24 call sites.
- **Decision:** keep `error` a string. Don't match the spec literally.
- **Why:** an API contract is a promise to existing callers, and the only caller here is our own frontend, which already depends on `error` being a string. Switching to a nested object would silently turn every `error` into `[object Object]` (or `undefined.message`) at two-dozen sites — a broad regression for zero functional gain, since a string already carries the message. Matching a spec is worthless if it breaks the consumers the spec exists to serve. The right move is to honor the contract the system actually has.
- **The migration path, if you ever want the object shape:** do it as an additive, backward-compatible change — return *both* `error` (string) and a new `errorDetail: { message, code }` for a release or two, migrate the 24 call sites to read the structured field, then drop the string. That's the same expand→migrate→contract discipline `migrations.md` prescribes for the database, applied to the API contract.

### `express-async-errors` instead of try/catch in every async route
- **Context:** Express 4's router calls handlers and only forwards *synchronously thrown* errors to error middleware. An `async` handler returns a promise; if it rejects, Express never sees it — you get an unhandled rejection and a hung request, not a 500 through `errorHandler`.
- **Decision:** `import 'express-async-errors'` once, at the top of `server.ts`.
- **Why:** the alternative is wrapping every async handler in try/catch (or an `asyncHandler` HOF) — easy to forget on exactly the one route that later throws. The import monkey-patches the router so a rejected promise is forwarded like a sync throw, making the centralized handler actually central. Cost: a small bit of import-order-sensitive magic (it must load before routers). Express 5 makes this native, at which point the dependency can be dropped.

### Health check must not touch the database
- **Context:** Railway and uptime monitors poll `/health` constantly and restart or alarm on failure.
- **Decision:** `/health` returns a static object — no auth, no DB query.
- **Why:** a health check should answer "is *this process* up and serving?" If it ran a query, then a slow or briefly-unavailable database would make the health check fail, the platform would kill and restart healthy app instances, and you'd amplify a database blip into a full outage right when you least want churn. Keep liveness independent of downstream dependencies. (If you later want a *readiness* check that does include the DB, that's a separate endpoint with separate semantics — don't overload `/health`.)

### helmet's Cross-Origin-Resource-Policy set to `cross-origin`
- **Context:** helmet's secure default sets `Cross-Origin-Resource-Policy: same-origin`, which tells browsers to refuse cross-origin loads of the resource. Our SPA runs on a *different* origin (Vercel) from the API (Railway).
- **Decision:** relax CORP to `cross-origin` while keeping helmet's other defaults (HSTS, `nosniff`, `X-Frame-Options`, etc.).
- **Why:** CORP and CORS solve different problems. CORS governs whether the browser lets JS *read* a cross-origin response (handled by our allowlist in `cors.ts`); CORP is a coarser "can this resource be embedded/loaded cross-origin at all" guard aimed mostly at protecting non-CORS subresources from side-channel attacks. For a JSON API deliberately consumed cross-origin by a known SPA, the strict `same-origin` CORP would block legitimate use, while CORS still does the real access control. Loosening CORP specifically, rather than disabling helmet wholesale, keeps every other hardening header intact.

### Per-user rate limiting, and its honest limitation
- **Context:** the AI endpoints cost real money per call.
- **Decision:** rate-limit keyed on `req.user.sub`, mounted after auth.
- **Why:** fairness behind shared IPs (NAT/proxy), as above. **The limitation to name out loud:** express-rate-limit's default store is **in-memory, per process**. With one Railway instance that's exactly correct. The moment the API scales horizontally, each instance keeps its own counters, so a user's effective limit multiplies by the instance count and the cap leaks. The fix when that day comes is a shared store (Redis via `rate-limit-redis`) — see Punted.

### A custom migration runner instead of the Supabase CLI
- **Context:** the team had been hand-pasting SQL into the Supabase editor — unauditable, easy to double-apply, impossible to roll back consistently.
- **Decision:** a ~200-line runner on the existing `pg` dep, not the Supabase CLI.
- **Why:** the CLI is a fine tool and uses the same core idea (ordered files + tracking table), but it's another install and it wants its own `supabase/migrations/` layout. The custom runner needs zero new tooling, works directly with the existing `migrations/NNN_*.sql` numbering, and runs identically in local/CI/prod off one `DATABASE_URL`. The migrations doc explicitly leaves the door open to adopt the CLI later (and how to repair its tracking table from `schema_migrations` if so) — this is a "haven't earned heavier tooling yet" call, not a rejection of it.

## What you should be able to explain in an interview

**Q: How does your API make sure errors are consistent and don't leak internals?**
There's one centralized Express error handler — the final 4-argument middleware, registered after all routes. Everything funnels there, including async throws, because we import `express-async-errors` which patches the router to forward rejected promises like synchronous throws. The handler always logs the full error with its stack to stderr as a JSON line, then decides what the *client* sees: a custom `ApiError` carries an `expose` flag, but the general rule is we expose 4xx messages and, in production, replace any 5xx with a generic "Internal server error." Same envelope as the rest of the API — `{ data: null, error: "message" }` — so the frontend parses an error response identically to a success.

**Q: Why is the error `error` field a string when the spec asked for an object?**
Because the API's real contract already says `error` is a string, and our frontend reads it that way in about two dozen places. Matching the spec literally would mean shipping `{ error: { message } }` and silently breaking all of those — turning the displayed error into `[object Object]` for no functional benefit, since the string already carries the message. The contract you have beats the spec on paper. If we genuinely wanted the structured shape later, I'd add a second field alongside `error`, migrate the call sites, then remove the old one — expand, migrate, contract — rather than break everyone in one commit.

**Q: Why rate-limit per user instead of per IP, and what breaks at scale?**
The limited endpoints call Anthropic, so this is cost protection. We key on the Supabase user id, not the IP, because behind a shared NAT or corporate proxy many real users share one egress IP — IP-keying would let one heavy user starve everyone behind that IP. We can do this because the limiter is mounted after auth, so the user id is on the request. The honest caveat: the store is in-memory per process, so it's exact for a single instance but leaks if we run multiple — each instance counts independently. The fix is a shared Redis store the day we scale out.

**Q: Why doesn't your health check query the database?**
Because a health check answers "is this process alive and serving?", and the platform restarts or alarms on failure. If it ran a query, a slow or briefly-down database would fail the check, the platform would kill healthy instances, and a small DB blip becomes a full outage with extra restart churn. Keeping liveness independent of downstream dependencies is the point. If I wanted a deeper "is everything wired up" probe, that's a separate readiness endpoint with different semantics.

**Q: Walk me through how your migration runner stays correct.**
It reads numbered SQL files in filename order and tracks applied ones in a `schema_migrations` table with a checksum. The key property is atomicity: each migration runs in one transaction *together with* the insert that records it — they commit together or roll back together, so you can never end up having applied a migration without recording it, or vice versa. The migration files wrap themselves in BEGIN/COMMIT for manual use, so the runner strips those standalone lines first to keep exactly one transaction — its own. The checksum catches anyone editing an already-applied file, because the rule is forward-only: you never edit history, you add a compensating migration. And there's a one-time `baseline` command that adopts a DB whose migrations were applied by hand, recording them as done without re-running the non-idempotent ones.

**Q: helmet sets a same-origin resource policy by default — why did you change it, and isn't that less secure?**
helmet's default `Cross-Origin-Resource-Policy: same-origin` would block our SPA, which runs on a different origin, from loading API responses. But CORP and CORS are different controls: CORS decides whether the browser lets JS read a cross-origin response, and that's still locked down by our origin allowlist. CORP is a coarser embed/load guard. For a JSON API that's *meant* to be called cross-origin by a known frontend, the right move is to relax CORP specifically to `cross-origin` while keeping every other helmet header — HSTS, nosniff, frame options — fully on. We loosened one header for a real reason, not disabled hardening.

## What to look up if you want to go deeper
- **Express error handling & async** — the Express "Error Handling" guide (the 4-argument arity rule), and `express-async-errors`' tiny source to see exactly what it patches. Then note Express 5 forwards async errors natively.
- **`express-rate-limit` v8** — its docs on `keyGenerator`, the `ipKeyGenerator` IPv6 helper, `standardHeaders: 'draft-7'`, and `rate-limit-redis` for the shared-store upgrade. The IETF `draft-ratelimit-headers` spec explains the `RateLimit-*` header format.
- **helmet & the web security headers it sets** — read helmet's docs, then the MDN pages for `Cross-Origin-Resource-Policy`, `Cross-Origin-Embedder-Policy`, HSTS (`Strict-Transport-Security`), and CSP. Understanding *why each default exists* is what lets you safely relax one.
- **OWASP** — the "Error Handling" and "Logging" cheat sheets (don't leak stack traces; log enough to investigate; never log secrets) map directly onto `errorHandler.ts` and `requestLogger.ts`.
- **Database migrations** — read the Supabase CLI migration docs to compare, and the Flyway/Liquibase "versioned vs. repeatable migrations" and "baseline" concepts, which this runner deliberately mirrors. "Expand and contract" (a.k.a. parallel change) is the canonical pattern for zero-downtime schema changes — Martin Fowler's "ParallelChange" writeup.
- **Backups & recovery** — RPO vs. RTO as concepts; the Postgres `pg_dump`/`pg_restore` docs (custom format, `--no-owner`); and the discipline of *testing* restores. Kleppmann's *Designing Data-Intensive Applications* ch. on reliability frames why "a backup you've never restored is a hope, not a backup."
- **Health checks & probes** — Kubernetes' liveness vs. readiness vs. startup probe docs are the clearest articulation of why liveness must not depend on downstream services, even though we're on Railway, not k8s.

## Things we punted (named technical debt)
- **In-memory rate-limit store.** Correct for one instance; the per-user cap multiplies (leaks) across multiple instances. Swap to `rate-limit-redis` before scaling the API out — same trigger as the scheduler's leader-election limitation from Sprint L+.
- **Rate limiting is request-count, not cost/token-aware.** A user under the request cap can still issue 50 maximally expensive prompts. A real cost guard would meter Anthropic *tokens* or dollars, not request count.
- **No structured error codes.** `ApiError` carries a status and a human message but no machine-readable `code`, so the frontend can't branch on error *type* without string-matching. The expand-and-contract path described above would add `errorDetail: { code }` when needed.
- **Logs go to stderr only — no aggregation or correlation IDs.** Structured JSON lines are aggregator-ready, but nothing ships them anywhere yet, and there's no per-request `requestId` tying a request log to its error log. Add a correlation id and a log drain (Railway → a log service) when debugging across requests gets painful.
- **No CI gate on migrations.** `migrate:status` exists but nothing in CI runs it; a developer can still forget to apply a pending migration before deploying code that needs it. A CI step (`migrate:status` against staging, fail on pending/drift) would close the loop.
- **Migration runner is forward-only with no automated rollback.** By design — rollback is a compensating migration or a restore — but there's no `down` and no dry-run *diff* of what a migration will change, only which files will run.
