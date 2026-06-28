# Sprint R — Reliability & Release

> **Theme:** No new product features. Turn excellent code into a *trustworthy system* —
> green quality gates, a CI gate that enforces them, consistent input validation, honest
> data, and less duplication at the boundaries that matter.
>
> Sprint R implements Phase 1 of the engineering review (`ENGINEERING_REVIEW.md`): R1 green
> tests + injected clock, R2 CI, R4 zod validation, R3/R7 `requireRestaurant` + lint + audit,
> R8 stale-data indicators, R9 honest README — plus the high-value duplication cleanup (R13).

---

## 1. Engineering Summary

### What changed (by sprint goal)

**R1 — Restored the quality gates.**
- **Green tests via an injected clock.** The 4 failing tests were time-bombs: `refreshDailySummaries`
  read `new Date()` inline to compute its trailing-30-day window, while the tests seeded orders on
  fixed dates (`2026-05-20/21`). Once the calendar moved past that window the function correctly
  returned 0 rows and the tests failed — on a clean clone, with nothing actually broken. Fix:
  `refreshDailySummaries(restaurantId, now = new Date())` now takes the instant as a parameter
  (default = real clock, so production is unchanged); the tests inject a fixed `NOW` anchored to the
  seed dates. The wall-clock coupling is gone, so the suite no longer rots with the calendar.
- **ESLint restored on both packages.** The backend had *no* ESLint at all; the frontend shipped the
  lint script and plugin deps but no config file, so `npm run lint` errored out. Both now have a
  pragmatic `.eslintrc.cjs` (catch real problems — unused vars, dead code — without fighting reviewed
  patterns like the intentional `console.error` structured logging). Restoring the gate surfaced 13
  genuine dead-code findings, all fixed.
- **Dependency vulnerabilities cleared.** `npm audit fix` (no `--force`, lockfile-only) removed the
  high-severity production vulns (`ws`, `qs`/`express`) on both packages. **0 high-severity production
  vulnerabilities** remain.

**R2 — Continuous Integration.** `.github/workflows/ci.yml` runs on every push to `main` and every PR:
backend typecheck · lint · tests · prod audit, and frontend typecheck · lint · prod audit, as two
parallel jobs. The repo now rejects broken code automatically instead of trusting the author to
remember — which is *how* a red suite and a dead lint script reached `main` in the first place.

**R3 — Standardized request validation.** A single `validateBody(schema)` middleware parses each write
route's body against a Zod schema before the handler runs; on success it **replaces `req.body` with the
parsed value**, so handlers receive only validated, coerced, trimmed input. Every write endpoint is now
covered (13 routes), replacing one thorough-but-hand-rolled validator (`delivery-economics`, ~45 lines)
and ~60 lines of per-field checks in `menu-items`, plus several routes that previously trusted the body
unconditionally (`createRestaurant`).

**R4 — Improved data trust.**
- **Revenue, clearly labeled.** The dashboard's "30-Day Revenue" sums `daily_summaries.total_revenue_cents`
  (line-item revenue = qty × price), while Orders/heatmap use `orders.total_cents` (POS gross, which can
  include tax/tips/discounts). These two notions legitimately differ. Rather than a risky data-model
  change, the dashboard now carries a methodology note explaining exactly what the headline number does
  and doesn't include — so an owner comparing against Square understands any gap instead of distrusting
  the product. (This is the review's #1 MVP trust risk, addressed via the lower-risk "label" path the
  review itself recommends.)
- **"Last synced" indicators.** A reusable `useLastSynced` hook + `LastSyncedIndicator` chip reduce the
  per-provider sync health into one freshness signal, shown on the Dashboard and Analytics pages.
- **Stale-data messaging instead of silent empties.** When a provider is connected but its last
  successful sync is missing or >24h old, the indicator turns into an amber "Data may be out of date —
  last synced X ago" warning — turning the silent-empty failure mode into an understood one.

**R5 — Reduced high-value duplication.**
- **`requireRestaurant` middleware** collapses the "resolve the caller's restaurant WHERE user_id = sub,
  404 if absent" block — the multi-tenant isolation boundary, previously copy-pasted across ~20 sites
  (4× in `analytics.ts` alone) — into one audited implementation. 12 of the 23 `eq('user_id')` lookups
  are gone; the 11 that remain are the restaurant-CRUD resource itself and the body/param-based ownership
  checks (integrations, menu items), which have intentionally different semantics.
- **`lib/format.ts`** centralizes money formatting (`formatCents`/`formatDollars`), replacing ~9 near-
  duplicate `cents → string` definitions, and **`relativeTime`**, replacing two identical copies.
- Net effect across the sprint: **−207 lines** of code (602 removed, 395 added) despite adding 7 new files.

### Why it matters
The review's headline was "a genuinely strong codebase whose own quality gates are red." That gap —
strong engineering, failing verification — is what made the project read as "doesn't actually work" to
anyone who cloned it. Closing it (green tests in CI, working lint, no prod vulns, one tenant boundary,
every write validated, honest docs) is what moves the project from "impressive prototype" to "trustworthy
system" without writing a single new feature.

### Technical tradeoffs
- **Label revenue vs. reconcile it.** Reconciling line-item revenue with POS gross would require schema
  and ingestion changes (out of scope, and risky). Labeling is lower-risk, ships now, and is honest. The
  reconciliation work is captured as a remaining risk.
- **Clock-as-parameter vs. a clock service.** A `now = new Date()` default parameter is the minimal,
  zero-churn form of clock injection for a one-shot function; a full injectable clock service would be
  over-engineering for the one function whose tests needed it.
- **`requireRestaurant` scoped to the clean pattern.** It was deliberately *not* forced onto the
  integration/menu-item routes, whose body/param-based ownership returns 403 (not 404) and needs token
  columns — applying it there would have changed API contracts for no gain.
- **Lint tuned to pass, not to crusade.** `no-explicit-any` is off (the data layer is genuinely
  dynamically shaped; this is review item L6, not Sprint R) so the gate enforces real correctness without
  a 200-finding cleanup that wasn't asked for.

### Remaining risks (explicitly out of scope this sprint)
- **Revenue is labeled, not reconciled.** The line-item vs. POS-gross gap still exists; a pilot owner
  could still notice it. True reconciliation is the Phase 3 follow-up.
- **`TOKEN_ENCRYPTION_KEY` is still not fail-fast validated** (review M7) — it's required at runtime but
  absent from the `env.ts` schema, so a misconfig boots fine and fails on first token op.
- **Ingestion still has no transaction / uses check-then-act dedup** (review H3) — the partial-write risk
  is unchanged.
- **Aggregation is still done in TypeScript** (review M1), and **rate limiting is still in-memory** (M4).
- **Frontend still has no tests** (review R15) — CI gates typecheck/lint/build for the frontend, not behavior.

---

## 2. Metrics (before → after)

| Metric | Before | After |
|---|---|---|
| Backend tests | **4 failing** / 167 (1 red suite) | **167 passing** / 167 (15 suites green) |
| Backend lint | **broken** — no config, `npm run lint` errors | **passing** (`eslint`, 0 warnings) |
| Frontend lint | **broken** — no config file | **passing** (0 warnings) |
| CI | **none** | GitHub Actions: typecheck · lint · test · audit, on push + PR |
| Prod dep vulns (high+) | backend **2**, frontend **1** | **0** / **0** |
| Tenant-resolution duplication | 23 `eq('user_id')` sites | **1 `requireRestaurant` middleware** (+11 intentional ownership checks) |
| Money-format duplication | ~9–11 ad-hoc definitions | **1 `lib/format.ts`** (2 specialized chart tick-formatters kept) |
| `relativeTime` duplication | 5 copies | **1 canonical** (+3 page-specific variants left) |
| Write-route validation | 1 thorough, rest manual/none | **Zod on all 13 write routes** via shared middleware |
| Net lines of code | — | **−207** (395 added / 602 removed, excl. lockfiles) |

---

## 3. Files changed

### Backend
- `middleware/requireRestaurant.ts` *(new)* — tenant resolution → `req.restaurantId` / `req.restaurant`.
- `middleware/validate.ts` *(new)* — `validateBody(schema)` Zod request-validation middleware.
- `types/express.d.ts` *(new)* — global `Request` augmentation (`user`, `restaurant`, `restaurantId`).
- `services/ingestion/persistence.ts` — `refreshDailySummaries` takes an injected `now` (kills the time-bomb).
- `middleware/chatDailyCap.ts` — uses the already-resolved `req.restaurantId` (no repeated lookup).
- `routes/alerts.ts`, `analytics.ts`, `advisor.ts`, `insights.ts`, `marketing.ts`, `chat.ts`,
  `integrations/syncStatus.ts` — adopt `requireRestaurant`; analytics/marketing/chat also adopt Zod.
- `routes/restaurant.ts`, `menuItems.ts`, `integrations/square.ts`, `integrations/doordash.ts` — Zod
  validation on write routes (menu-items replaces ~60 lines of manual checks).
- `routes/advisor.ts`, `routes/integrations/syncStatus.ts`, `services/square/ingestSquare.ts` — dead-code
  removal surfaced by ESLint.
- `.eslintrc.cjs` *(new)*, `package.json` — ESLint config + tooling; `typecheck`/`lint` scripts.

### Frontend
- `lib/format.ts` *(new)* — `formatCents`, `formatDollars`, `relativeTime`.
- `lib/useLastSynced.ts` *(new)* — sync-freshness hook.
- `components/LastSyncedIndicator.tsx` *(new)* — "last synced / stale" chip.
- `pages/Dashboard.tsx` — last-synced chip + revenue methodology note.
- `pages/Analytics.tsx` — last-synced chip.
- `components/DashboardKpis.tsx`, `MenuItemsTable.tsx`, `advisor/ForecastTable.tsx`,
  `charts/TopItemsChart.tsx`, `charts/SalesHeatmap.tsx`, `pages/ChannelMargins.tsx`, `MarginAnalysis.tsx`
  — use shared money formatters.
- `pages/Integrations.tsx`, `SyncHealth.tsx` — use shared `relativeTime`.
- `.eslintrc.cjs` *(new)*, `package.json` — ESLint config + `typecheck` script.

### Infrastructure
- `.github/workflows/ci.yml` *(new)* — the CI gate.

### Documentation
- `README.md`, `RestaurantIQ/README.md` — corrected test count (95→167), migration count (23→25), and
  the "raw SQL throughout" over-claim (it's Supabase PostgREST for app queries; raw `pg` only in the
  migration runner + scheduler).
- `RestaurantIQ/CLAUDE.md` — Toast → Square drift fixed (`toast_guid` → `square_location_id`).

### Testing
- `services/ingestion/__tests__/persistence.test.ts` — inject a fixed clock into `refreshDailySummaries`.
- `channelMarginService.test.ts`, `ingestDoorDash.test.ts`, `leaderElection.test.ts` — removed dead test
  setup surfaced by ESLint.

---

## 4. Manual Testing Checklist

Run after pulling this branch. Backend: `npm ci && npm test && npm run lint`. Frontend: `npm ci && npm run build && npm run lint`.

- [ ] **Authentication** — sign up, log in, log out, password reset still work; protected routes redirect when logged out.
- [ ] **Restaurant creation** — onboarding creates a restaurant; missing `name` now returns a clean 400; a second create returns 409.
- [ ] **Analytics** — dashboard KPIs, revenue trend, top items, and heatmap render; the revenue methodology note is visible; "Last synced" chip shows.
- [ ] **AI assistant** — chat sends a message and gets a grounded reply; empty/too-long messages are rejected with 400; daily cap still enforced.
- [ ] **Sync** — connect Square/DoorDash (sandbox), trigger a manual sync; connect with a missing field returns 400; in-flight sync returns 409.
- [ ] **Forecasting** — `GET /advisor/forecast` returns cached/empty; `POST /forecast/refresh` generates and caches.
- [ ] **Dashboards** — with stale/absent sync, the amber "Data may be out of date" message appears instead of a silent empty dashboard.
- [ ] **Onboarding** — guided setup flows end-to-end; menu-item cost edits validate (`cost_cents` integer ≥ 0) and persist.
- [ ] **Cross-tenant** — every analytics/alerts/chat/marketing call resolves the restaurant from the JWT, never a client-supplied id.

---

## 5. Definition of Done

| Criterion | Status |
|---|---|
| All backend tests pass | ✅ 167/167 |
| Lint passes (both packages) | ✅ |
| CI is operational | ✅ `.github/workflows/ci.yml` |
| Request validation standardized | ✅ Zod on all write routes via `validateBody` |
| Revenue trustworthy or clearly explained | ✅ methodology note (labeled, per review's recommended path) |
| Stale-data messaging implemented | ✅ `LastSyncedIndicator` |
| High-value duplication reduced | ✅ `requireRestaurant`, `lib/format.ts`, `relativeTime` |
| No user-facing functionality regressed | ✅ typecheck + build green; behavior preserved |
| Documentation reflects reality | ✅ README counts + raw-SQL claim, CLAUDE.md Square |
| No high-severity prod vulnerabilities | ✅ 0 / 0 |

---

## 6. What you should be able to explain in an interview

- **Why time-dependent tests are a code smell, not a test smell.** The fix was in the *production* code
  (inject the clock), because the root cause was production reading the wall clock — the same bug that
  would show a real user a silently-empty dashboard after a lapsed sync.
- **Why validation belongs in middleware, not the controller.** `validateBody` replaces `req.body` with
  the parsed value, so the service layer can *assume* its inputs — you can reason about what's guaranteed.
- **Why `requireRestaurant` is a security control, not just DRY.** It's the multi-tenant isolation
  boundary; one implementation means one place to audit, not 23 places to get subtly wrong.
- **Why CI is the actual deliverable.** The tests already existed and were good; the missing piece was a
  gate that runs them. Process, not code, was the gap.
