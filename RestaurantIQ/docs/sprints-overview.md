# RestaurantIQ — Sprint Overview

A running log of every sprint shipped, oldest to newest. Each entry is a quick 3–4 bullet summary. Deeper write-ups live in [`docs/weekly-summary/`](weekly-summary/).

---

## Sprint A — Square Integration, Real Auth & Live Dashboard
- Connected Square POS as the first order source, landing real catalog and order data in Postgres.
- Wired up JWT auth with JWKS verification so routes are scoped to the authenticated owner's restaurant.
- Hooked the frontend dashboard to live backend data instead of mocks.
- Established the multi-tenant trust boundary (`restaurantId` required, no cross-tenant leakage).

## Sprint B — AI Insights Backend Layer
- Added `GET /api/insights`: pulls a restaurant's last 30 days of daily summaries and returns 5–8 prioritized, structured recommendations.
- First Claude integration (Haiku), returning structured JSON instead of prose so the frontend can render directly.
- Enabled prompt caching on the long system prompt to avoid re-billing it every request.
- Graceful empty state — under 3 days of data returns a "not enough data yet" insight instead of calling Anthropic.

## Sprint C — AI Insights Dashboard + Deterministic Alerts Engine
- Built the frontend Insights panel to render the structured recommendations from Sprint B.
- Added a deterministic (rule-based, non-AI) alerts engine: no-sales, trending-down, new-top-performer.
- Shipped the unread-alert UI with read/unread state.
- Proved the full chain end to end: data → rules/AI → API → UI.

## Sprint D — Recharts Analytics Dashboard
- Built the visual analytics layer: revenue trend, top items, and a time-of-day sales heatmap.
- Standardized on Recharts for all data visualizations.
- Surfaced top/bottom items by revenue and week-over-week trends.

## Sprint E — AI Marketing Copy Generator
- Added AI-generated marketing copy (social captions, promo ideas) driven by item performance.
- Reused the Claude integration pattern from Sprint B.
- Gave owners actionable marketing output, not just analytics.

## Sprint F — Alerts Hardening + Browser Push Notifications
- Made the alerts system safe to leave alone: CHECK constraint on alert types, idempotent mark-read, frontend resilience.
- Added a tuned `(restaurant_id, created_at DESC)` index for the alerts list query.
- Shipped native browser push notifications (deferred service-worker/Push API as the future upgrade path).
- Pre-wired all five layers for future alert rules (stub-now / fill-later).

## Sprint G — Guided Onboarding + Empty-State Flow
- Fixed the first-run experience with a guided onboarding flow.
- Polished empty states so a brand-new restaurant doesn't see broken or blank views.
- Made the product feel finished before a real user touches it.

## Sprint H — Margin Analysis Dashboard (+ 8-Risk Audit)
- Added the margin/profitability analytics view, the highest-leverage new dashboard.
- Gated all margin math behind a `cost_known` guard so uncosted items never report a fake 100% margin.
- Ran a production-hardening risk audit closing 8 ways the system could corrupt data or leak secrets.

## Sprint I — Manual Menu-Item Cost Entry
- Added `PATCH .../menu-items/:itemId` plus an edit modal so owners can type in item costs.
- Unlocked the Sprint H margin view, which was dark because Square never reports item cost.
- Carried `null` cost end to end ("unknown cost" ≠ "$0"), rendering a "Missing cost" badge.
- Zero new SQL — `cost_cents` already existed as a nullable column from day one.

## Sprint J — DoorDash as a Second Order Source
- Added DoorDash as a first-class order source, making "unified POS + delivery" actually true.
- Extracted Square's proven ingestion into a shared `services/ingestion/` pipeline parametrized by source (not copy-paste).
- Added self-refreshing OAuth tokens (Square + DoorDash) encrypted at rest with key rotation.
- First real Jest suite (29 tests) guarding the money- and security-critical paths.

## Sprint K — DoorDash Trust & Hardening / Test Coverage
- Expanded the backend test suite to 9 suites / 95 tests (up from 8 / 86).
- Added DoorDash and shared-ingestion test coverage hardening the new pipeline.
- Produced a findings report validating the second-channel ingestion under edge cases.

## Sprint L — Automated Integration Sync + Health UI
- Added a scheduler that runs ingestion automatically instead of only on manual `/sync`.
- Unified manual and automated sync onto a single `syncIntegration` code path with a per-restaurant lock.
- Added `integration_sync_status` (one-row-per restaurant+provider health snapshot) and a `/sync-status` endpoint + health UI.

## Sprint L+ — Distributed Sync Infrastructure
- Made the scheduler safe across multiple backend instances via a Postgres advisory-lock leader election.
- Added `sync_jobs`, an append-only audit log with a 7-state lifecycle and a Postgres-backed retry/backoff queue that survives crashes.
- Added `GET /api/integrations/sync-metrics` and an ops dashboard for sync health.
- Sole-leader fallback: no `DATABASE_URL` → behaves as permanent leader (dev/mock unchanged).

## Sprint M — Deployment Readiness
- Made the API base URL configurable so frontend and backend can live on different hosts.
- Added a CORS allowlist and environment-variable validation at startup.
- Prepared the app for real Railway (backend) + Vercel (frontend) deployment.

## Sprint N — Production Hardening, Security & Operations
- Added centralized error handling, rate limiting, security headers (helmet), and structured logging.
- Added a health endpoint and a forward-only migration runner.
- Wrote the human runbooks: `deployment.md`, `operations.md`, `migrations.md` (incl. the token-encryption-key/DB-restore coupling).
- Noted the in-memory rate-limit store as the next scale-out swap (→ `rate-limit-redis`).

## Sprint O — Branding, Design System & UX Polish
- First frontend-only sprint: centralized the brand in one Tailwind theme (navy palette, Hanken Grotesk type, semantic `ink`/`line`/`pos`/`neg` tokens) so a rebrand is one edit.
- Replaced all emoji with a hand-drawn SVG `Icon` set and added a public landing page, a split-screen branded auth flow (`AuthShell`), a new topbar, and a dashboard KPI strip.
- Re-themed every page, chart, and table onto the design tokens; added a shared `useUnreadAlerts` hook for the sidebar/topbar badge.
- No backend or API-contract changes — presentation only; KPIs deliberately omit fabricated week-over-week deltas the API can't substantiate.
