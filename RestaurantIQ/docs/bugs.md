# Bug Log — RestaurantIQ

A running record of every notable bug found during development: what broke, how it was diagnosed, what fixed it, and what the pattern tells you. Organized by category rather than chronology.

---

## React & Frontend

### 1. Flash of onboarding screen on login

**Symptom.** After signing in, the screen would briefly flash the "add your restaurant name and address" onboarding form before landing on the dashboard.

**Diagnosis.** When the Supabase session changed from `null` to a valid session, `RestaurantContext` was in state `{ loading: false, restaurant: null }` — the settled state from when the user was logged out. React re-rendered the component tree with this stale state before the `useEffect` had a chance to fire and reset `loading` to `true`. `RequireRestaurant` saw `loading: false` and `restaurant: null` and immediately rendered `<Navigate to="/onboarding" />`. Because `<Navigate>` changes the URL *during the render phase*, the redirect committed before any effects ran.

**First attempt (wrong).** Added a `useLayoutEffect` to reset `loading = true` when the session appeared. `useLayoutEffect` fires before paint, so we assumed it would prevent the flash. It didn't — `<Navigate>` changes the router state during the render itself, not during paint. By the time the layout effect fired, the URL had already changed to `/onboarding`.

**Fix.** Used React's "setState during render" pattern in `RestaurantProvider`. When the component detects that `session.user.id` has changed to a non-null value mid-render, it calls `setLoading(true)` immediately. React sees the setState call, discards the current render, and re-renders the provider before rendering any children. `RequireRestaurant` therefore only ever renders with `loading: true` when a new session has appeared — it never sees the stale `loading: false, restaurant: null` combination.

**Lesson.** `useLayoutEffect` fires before paint, but after render. `<Navigate>` fires *during* render. If you need to prevent a child from seeing an intermediate state, you must act during the parent's render pass — not after it.

---

### 2. Always-loading UI (infinite skeleton)

**Symptom.** If a user landed on the Insights page during a race condition around sign-in, they saw an animated loading skeleton that never resolved.

**Diagnosis.** The `useEffect` that fetched insights had an early-return guard: `if (!session) return;`. When the session was absent, the effect returned without calling `setState`. The component's initial state was `{ status: 'loading' }`, so with nothing to change it, the loading state persisted forever.

**Fix.** Made the no-session path explicit: `setFetchState({ status: 'error', message: 'Not authenticated.' })`. Every code path through the effect now calls `setState` exactly once.

**Lesson.** An "always-loading" UI almost always means a `useEffect` code path that returns early without updating state. If your initial state is `loading`, every branch must eventually transition out of it.

---

### 3. Optimistic UI race condition in alerts

**Symptom.** If a user clicked "Mark read" on a single alert while "Mark all read" was in flight, both requests would hit the server. The per-item rollback could then restore stale state — the list would momentarily resurrect already-read alerts.

**Diagnosis.** The `isMarkingAll` guard flag was set *after* the optimistic state mutation. Between the mutation and the flag assignment, React could re-render, and a concurrent click handler would find `isMarkingAll === false` and proceed.

**Fix.** Reordered: set `isMarkingAll = true` before the optimistic mutation, and added the `isMarkingAll` guard symmetrically to the per-item handler.

**Lesson.** Acquire your lock before touching shared state, not after. Same rule as a mutex — if you set the flag after publishing the effect, you haven't protected anything.

---

### 4. PostgREST embeds return arrays, not objects

**Symptom.** Every insight Claude generated used `menu_item_name: "Unknown"` instead of the actual item name. No error was thrown.

**Diagnosis.** The Supabase query used PostgREST's embed syntax: `select('*, menu_items(name, category)')`. The TypeScript type assumed `row.menu_items` was `{ name: string } | null`. At runtime, PostgREST serializes *every* embedded relation as an array regardless of FK cardinality. So `row.menu_items` was actually `[{ name: 'Burger' }]`, and `row.menu_items?.name` evaluated to `undefined`. The code silently substituted `'Unknown'` for every item name before sending data to Claude.

**Fix.** Changed the TypeScript type to `{ name: string; category: string }[] | null` and unwrapped with `[0]` at the read site.

**Lesson.** PostgREST doesn't collapse single-row embeds into objects — it always returns arrays. Never hand-write the TypeScript type for a PostgREST query; derive it from a real fixture response or use the generated Supabase types. `tsc --noEmit` in CI caught this one at compile time.

---

### 5. Tailwind JIT tree-shakes dynamic class names

**Symptom.** Category color chips on insight cards rendered with no background or text color — the Tailwind classes were missing from the compiled CSS.

**Diagnosis.** The early version constructed class names dynamically: `` `bg-${category}-100 text-${category}-800` ``. Tailwind's JIT scanner reads source files as text at build time and emits only the class names it can find as literal substrings. A dynamically constructed string is never a literal substring — so those classes were never emitted.

**Fix.** Replaced with a `CATEGORY_CONFIG` record mapping each category to a full, precomposed class string: `{ chip: 'bg-blue-100 text-blue-800' }`. Verbose, but the only way to make static analysis work.

**Lesson.** Tailwind's JIT is a static analysis tool, not a runtime system. Any class name that isn't a complete literal string in your source won't make it into production CSS.

---

### 6. Landing page unreachable

**Symptom.** The landing page at `/welcome` was never shown to anyone. Logged-out users visiting `/` were sent to `/login`; the catch-all `*` route redirected everything else to `/`.

**Diagnosis.** The `/` route was wrapped in `ProtectedRoute`, which redirected unauthenticated users to `/login` — never to `/welcome`. No other route or link pointed to `/welcome`. The landing page existed but had no entry point.

**Fix.** Added a `SmartHome` component at `/`: renders `<Landing />` if the user is not authenticated, `<AppLayout><Dashboard /></AppLayout>` if they are. `/welcome` now redirects to `/`.

---

## Backend & API

### 7. Chat white screen — mismatched property name across service boundary

**Symptom.** User typed a question, saw the three-dot loading indicator, and then the page went white.

**Diagnosis.** `chatService.ts` returned `{ assistantMessage, usage }`. The route handler passed this object directly as the `data` field of the response. The frontend expected `{ message, usage }` — the same shape used by every other endpoint. `message` was `undefined`. The undefined value was pushed into the messages array. `MessageThread` crashed trying to read `.role` off `undefined`.

**Fix.** Added an explicit translation at the route boundary: `const { assistantMessage, usage } = result; res.json({ data: { message: assistantMessage, usage } })`.

**Lesson.** Service-internal property names and wire format property names should be treated as separate concerns with an explicit translation step at the boundary. Returning service objects directly couples your API contract to whatever the implementer happened to name a variable.

---

### 8. `dotenv.config()` loaded after imports, API key was `undefined`

**Symptom.** The Anthropic SDK threw at import time because `process.env.ANTHROPIC_API_KEY` was `undefined`.

**Diagnosis.** Node evaluates ES module imports eagerly, in order, before any imperative code runs. The service file constructed the Anthropic SDK client at module load time. `dotenv.config()` was called in `server.ts` — but `server.ts` imported the service file first, so the SDK constructor read the env var before `dotenv` had populated it.

**Fix.** Moved SDK construction inside the function body, so it happens on first call — by which point `server.ts` has definitely run `dotenv.config()`.

**Lesson.** Any code that reads `process.env` at module load time is fragile. Prefer reading env vars at call time (lazy initialization), not at import time. The same pattern applies to database clients, loggers, and anything else that reads config on construction.

---

### 9. Advisory lock released immediately through PostgREST

**Symptom.** The distributed scheduler's leader election appeared to work but every instance immediately lost the lock — no leader ever held it for more than one tick.

**Diagnosis.** The initial implementation used the Supabase JS client to call `pg_try_advisory_lock`. Supabase JS talks to Postgres through PostgREST over HTTP — each query is a stateless round-trip through a connection pooler. A session-level advisory lock is bound to a single Postgres session; the moment that session is returned to the pool, the lock is released. The lock was acquired and released on every call.

**Fix.** Leader election uses a dedicated raw `pg.Client` that holds a single Postgres session for the entire process lifetime. This is the one place in the codebase that bypasses Supabase JS — because the feature is fundamentally session-scoped.

**Lesson.** Session-level Postgres features (advisory locks, temporary tables, `SET LOCAL`) cannot be used through a connection pooler or an HTTP adapter. Know when you need a dedicated, persistent connection.

---

### 10. Infinite retry loop in the sync scheduler

**Symptom.** A single failed sync job would be re-dispatched on every scheduler tick indefinitely, flooding the job table with duplicate attempts.

**Diagnosis.** The retry logic created a *new* `sync_jobs` row for each retry attempt. The original row remained in `pending_retry` status. The due-retry query filtered on `status = 'pending_retry'`, so the original row was returned on every tick and re-dispatched every time — regardless of whether the retry had already been picked up.

**Fix.** Retries continue their own job row. The executor receives the existing `job.id` and calls `markRunning`, which flips the row from `pending_retry` to `running`. Because the query filters on `status = 'pending_retry'`, a running row is no longer returned. A regression test was added to cover this case.

**Lesson.** When the failure mode of a bug is unbounded repetition (infinite loops, infinite re-dispatch), the root cause is almost always a state transition that never terminates — a row that never leaves the state that causes it to be re-selected. Design job queues so a row can only be re-selected when it is explicitly in a waiting state.

---

### 11. Alerts CHECK constraint — existence ≠ correctness

**Symptom.** Adding new alert types to the `CHECK` constraint silently failed. The new values were rejected at runtime even though the migration appeared to succeed.

**Diagnosis.** The migration used `IF NOT EXISTS` to guard the `ADD CONSTRAINT` statement. A constraint named `alerts_type_check` already existed — from an earlier migration with only three allowed values. The guard saw the name and skipped the `ADD`, leaving the old, narrower constraint in place.

**Fix.** Changed the migration pattern to `DROP CONSTRAINT IF EXISTS alerts_type_check; ALTER TABLE ADD CONSTRAINT alerts_type_check CHECK (...)`. Drop-then-add forces the constraint into its correct shape regardless of prior state.

**Lesson.** `IF NOT EXISTS` answers "does a thing with this name exist?" It does not answer "is the existing thing correct?" For schema objects that can change shape, drop-then-create is more robust than create-if-missing.

---

### 12. NOT NULL column on a non-empty table

**Symptom.** Adding a `dedup_key TEXT NOT NULL` column to the alerts table failed because existing rows would violate the constraint.

**Fix.** Three-step migration: (1) add the column as nullable, (2) backfill existing rows (`UPDATE alerts SET dedup_key = id::text WHERE dedup_key IS NULL`), (3) add the `NOT NULL` constraint. This is the standard safe pattern for adding a required column to a live table without locking it.

---

## Deployment

### 13. Railway build failed — `tsc: not found`

**Symptom.** Railway builds failed immediately with `tsc: command not found`.

**Diagnosis.** Railway's default Nixpacks build runs `npm ci --omit=dev` (skipping devDependencies) before the build step. TypeScript is a devDependency. So `tsc` was unavailable when the build script ran.

**Fix.** Added `nixpacks.toml` specifying `npm ci` (full install including devDeps) followed by `npm run build` followed by `npm start`. This overrides Nixpacks's production-install default.

**Lesson.** Build tools (TypeScript, esbuild, webpack) are typically devDependencies. Any deploy platform that strips devDeps before building will break unless you explicitly configure it not to.

---

### 14. Vercel 404 on direct navigation to any route except `/`

**Symptom.** Navigating directly to `/analytics`, `/chat`, or any other route in the deployed app returned a 404.

**Diagnosis.** Vite builds a single-page application — there is no file at `/analytics` on disk. When Vercel receives a request for `/analytics`, it looks for a file at that path, finds nothing, and returns 404. Client-side routing only works after the initial `index.html` is loaded and React Router takes over.

**Fix.** Added `vercel.json` with a catch-all rewrite: `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`. Every request is served `index.html`; React Router then reads the URL and renders the correct page.

**Lesson.** SPA routing requires the server to serve `index.html` for every path. On Netlify this is `_redirects`; on Vercel it's `vercel.json` rewrites; on nginx it's `try_files $uri /index.html`. Not knowing this is one of the most common first-deploy surprises.

---

### 15. Frontend calling `localhost:3001` in production

**Symptom.** Every API call failed silently in the production Vercel deploy.

**Diagnosis.** The API base URL was read from `VITE_API_URL` with a fallback to `http://localhost:3001`. The env var was not set in Vercel's environment settings, so the fallback was baked into the compiled bundle. All API calls hit localhost from users' browsers and failed immediately.

**Fix.** Set `VITE_API_URL=https://restaurantiq-production-5c1c.up.railway.app` in Vercel's environment variables and redeployed.

**Lesson.** Vite bakes env vars into the bundle at build time — `import.meta.env.VITE_*` is substituted statically. If the var isn't set in the build environment, the fallback is what ships. Always verify env vars are set in the deploy platform before testing a production build.

---

## Data & Schema

### 16. Margin showing 100% for uncosted items

**Symptom.** Menu items with no cost entered showed a 100% profit margin on the margin analysis dashboard.

**Diagnosis.** The margin calculation divided `(price - cost) / price`. When `cost_cents` was `null`, JavaScript coerced it to `0`, making every item appear fully profitable.

**Fix.** Added a `cost_known` guard: items where `cost_cents IS NULL` are excluded from margin calculations and rendered with a "Missing cost" badge instead. `null` cost and `$0` cost are treated as distinct states throughout.

**Lesson.** `null` means "unknown," not `0`. Never coerce nulls to numeric zero in financial calculations — the failure mode is confidently wrong numbers, which is worse than showing nothing.
