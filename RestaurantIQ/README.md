# RestaurantIQ

[![License: MIT](https://img.shields.io/badge/License-MIT-navy.svg)](LICENSE)
[![Database Schema](https://img.shields.io/badge/Database-Schema-4A90E2.svg)](docs/schema.md)

**Restaurant analytics and AI advisory platform.** Connects to Square POS and DoorDash, aggregates every order into a unified data layer, and surfaces AI-powered insights, forecasts, and a conversational assistant — all grounded in the restaurant's real numbers.

Live on Railway (backend) + Vercel (frontend).

![RestaurantIQ dashboard — menu performance, KPIs, and the "needs attention today" strip](docs/screenshots/dashboard.png)

---

## Why this exists

I've worked in food service, and a lot of that time was spent staring at the POS. The register sees everything — every order, every item, every rush and every dead hour — but the analytics stop at a sales report. That gap kept bothering me:

- **POS menu analytics are shallow.** Square (like most POS reporting) ranks items by sales. It won't tell you which "top seller" actually loses money once ingredient cost is factored in, or which item is quietly trending down 20% week over week.
- **Delivery data lives in a silo.** DoorDash orders sit in DoorDash's dashboard with their own fees and their own math. Nobody merges the channels, so nobody sees a dish's real margin after the delivery commission comes out.
- **Reports describe; they don't advise.** Even when the numbers exist, the owner is left to interpret them between rushes. Nothing says *reprice this, promote this, cut this — and here's the math behind it.*
- **The tools that do this are built for chains.** Enterprise restaurant-intelligence platforms target multi-location groups with analyst teams. The independent single-location restaurant — most of the industry — gets a spreadsheet.

RestaurantIQ is my attempt to close that gap: one place where POS and delivery orders merge into a single data layer, per-dish margins are computed honestly (no fake 100% margins on uncosted items), and an AI layer turns the numbers into a short, prioritized list of things worth doing this week.

---

## What it does

A restaurant owner connects their Square POS and DoorDash account once. From that point on, RestaurantIQ syncs their order history automatically, computes menu performance metrics, and makes the numbers actionable:

- **Analytics dashboard** — revenue trend, top/bottom items by revenue, time-of-day sales heatmap, week-over-week comparisons
- **Margin analysis** — true profit per dish once cost is entered, with a `null`-safe guard so uncosted items never report a fake 100% margin
- **AI Insights** — Claude reads 30 days of daily summaries and returns 5–8 prioritized, structured recommendations (what to reprice, promote, or cut), rendered as cards with priority triage
- **AI Chat** — multi-turn conversation grounded in the restaurant's last 28 days of data; context is attached per turn, capped at 8 turns to bound token cost, conversations persist
- **Purchasing Advisor** — TypeScript linear regression produces per-item demand forecasts; Claude narrates the finished numbers in business language. Math is deterministic and testable; the LLM never touches unit counts
- **Alerts engine** — deterministic rules flag items not selling, trending down 20%+, and new top performers; unread count surfaces in the sidebar and topbar
- **Marketing copy** — AI-generated social captions and promo ideas driven by actual item performance
- **Sync Health dashboard** — live view of the distributed sync scheduler: leader identity, per-provider success rates, recent job history, retry queue depth

### Screenshots

| | |
|---|---|
| ![Analytics — revenue trend, top items by revenue, busiest-hours heatmap](docs/screenshots/analytics.png) | ![AI Insights — prioritized recommendation cards with supporting numbers](docs/screenshots/ai-assistant.png) |
| *Analytics: revenue trend, top items, busiest hours* | *AI Insights: prioritized actions with supporting numbers* |
| ![Margins — profitability by item, top profit contributors](docs/screenshots/margins.png) | ![Demand Forecast — 7-day per-item projections with confidence tiers](docs/screenshots/advisor.png) |
| *Margins: true profit per dish once costs are entered* | *Demand Forecast: deterministic projections, tiered confidence* |
| ![Alerts — deterministic menu-performance notifications](docs/screenshots/alerts.png) | |
| *Alerts: trending-down and zero-sales rules, no AI required* | |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Recharts |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL via Supabase (26 migrations) |
| Auth | Supabase Auth + custom JWT middleware (JWKS) |
| AI | Anthropic Claude API (forced tool use, prompt caching) |
| Integrations | Square Node SDK, DoorDash OAuth2 API |
| Hosting | Railway (backend) + Vercel (frontend) |
| Testing | Jest — 18 suites, 279 tests (CI-gated) |

```mermaid
graph LR
    User(["Restaurant Owner"])

    subgraph Vercel["Vercel — Frontend"]
        React["React 18 · Vite\nTypeScript · Tailwind · Recharts"]
    end

    subgraph Railway["Railway — Backend"]
        Express["Express · TypeScript"]
        Scheduler["Sync Scheduler\nleader-elected"]
    end

    subgraph Supabase["Supabase"]
        Postgres[("PostgreSQL\n26 migrations")]
        Auth["Auth / JWKS"]
    end

    Square["Square API"]
    DoorDash["DoorDash API"]
    Claude["Anthropic\nClaude API"]

    User -->|HTTPS| React
    React -->|"REST + JWT"| Express
    Express -.->|"JWKS verify"| Auth
    Express -->|"SQL queries"| Postgres
    Express -->|OAuth2| Square
    Express -->|OAuth2| DoorDash
    Express -->|"tool use + caching"| Claude
    Scheduler -->|"advisory lock"| Postgres
    Scheduler -->|ingest| Square
    Scheduler -->|ingest| DoorDash
```

---

## Architecture highlights

### Distributed sync scheduler with leader election

The backend is designed to run as multiple instances simultaneously — Railway replicas, rolling deploys — without any two of them duplicating or dropping sync work. Three independent coordination layers:

| Layer | Mechanism |
|---|---|
| Which instance schedules at all | Postgres session-level advisory lock (`pg_try_advisory_lock`) |
| No two syncs overlap per restaurant | `integration_sync_status.locked_at` conditional UPDATE |
| Durable retry + audit trail | `sync_jobs` append-only table, 6-state lifecycle |

The advisory lock is held on a dedicated raw `pg.Client` for the process lifetime — not through Supabase's PostgREST layer, which would release it immediately on pool return. On crash or deploy, Postgres auto-releases the lock and a standby takes over within one scheduler tick.

Retry state lives entirely in Postgres — no `setTimeout`s, no in-memory queues. Retries survive crashes and deploys. Backoff schedule: 0s → 1m → 5m → 15m → 60m → `failed_permanently`. Auth failures go straight to permanent (no point hammering a dead credential).

```mermaid
flowchart TD
    Tick([Scheduler tick]) --> Lock{"pg_try_advisory_lock\nprocess-level"}
    Lock -->|lost| Wait([Standby — wait for next tick])
    Lock -->|"won — leader"| List["Query restaurants\nwith active integrations"]
    List --> Row{"Conditional UPDATE\nlocked_at IS NULL\nOR locked_at stale"}
    Row -->|"0 rows — already running"| Skip([Skip])
    Row -->|"1 row — lock acquired"| Ingest["Run ingest\nSquare or DoorDash"]
    Ingest -->|success| Done["status = success\nlocked_at = NULL"]
    Ingest -->|"auth error"| Perm["status = failed_permanently\nno retry"]
    Ingest -->|"transient error"| Retry["status = pending_retry\nnext_retry_at = now + backoff"]
    Retry --> Scale["0 s → 1 m → 5 m → 15 m → 60 m → failed_permanently"]
```

### AI integration with cost controls

All Claude calls use **forced tool use** (`tool_choice: { type: 'tool', name: '…' }`), which validates output against a schema server-side — no prompt-engineering workarounds for JSON reliability. The system prompt is deliberately over 1024 tokens to qualify for Anthropic's **prompt caching**, cutting repeat-call input cost by ~90%.

The purchasing advisor separates concerns: TypeScript computes the linear regression, clamps projections to ±50% of last-week actuals, tiers confidence at 14/21/28 days, and refuses to forecast items with fewer than 14 days of history. Claude receives the finished numbers and writes only the narrative. `GET /forecast` is a pure cache read; `POST /forecast/refresh` is the only path that spends.

```mermaid
flowchart LR
    subgraph Insights["Insights"]
        direction TB
        I1["30-day daily_summaries"] --> I2["System prompt\n>1024 tokens — prompt-cached"]
        I2 --> I3["Claude\nforced tool_choice\nschema-validated output"]
        I3 --> I4["5–8 recommendation\ncards with priority"]
    end

    subgraph Chat["AI Chat"]
        direction TB
        C1["28-day data\ncontext window"] --> C2["Message history\ncapped at 8 turns"]
        C2 --> C3["Claude\nmulti-turn conversation"]
        C3 --> C4["Persisted to\nchat_messages"]
    end

    subgraph Advisor["Purchasing Advisor"]
        direction TB
        A1["TypeScript\nlinear regression"] --> A2["Clamp ±50%\ntier confidence\n14 / 21 / 28 days"]
        A2 --> A3{Cache fresh?}
        A3 -->|"GET /forecast\nfree read"| A4["Return\ncached payload"]
        A3 -->|"POST /forecast/refresh\nrate-limited"| A5["Claude narrates\nthe numbers"]
        A5 --> A4
    end
```

### Multi-tenant security

Every protected route validates a JWT against Supabase's JWKS endpoint. Every database query is scoped with `WHERE restaurant_id = $1` resolved from the authenticated user's `sub` — there is no path for a user to read another restaurant's data. OAuth tokens (Square, DoorDash) are AES-256-GCM encrypted at rest with key rotation support.

### Schema evolution

26 forward-only SQL migrations in `restaurantiq-backend/migrations/`. A custom migration runner (`src/scripts/migrate.ts`) applies them in order and records each in a `schema_migrations` table. No ORM: the schema is hand-written SQL — every index and constraint explicit — while application queries use Supabase's PostgREST query builder (raw `pg` is reserved for the migration runner and the advisory-lock scheduler).

---

## Project structure

```
RestaurantIQ/
├── restaurantiq-backend/
│   ├── src/
│   │   ├── middleware/       # auth, rate limiting, error handling, chat daily cap
│   │   ├── routes/           # REST endpoints (analytics, insights, chat, advisor, …)
│   │   ├── services/
│   │   │   ├── scheduler/    # leader election, sync jobs, retry, metrics
│   │   │   ├── square/       # Square SDK ingestion + normalizers
│   │   │   ├── doordash/     # DoorDash OAuth ingestion + normalizers
│   │   │   └── ingestion/    # shared persistence layer (upsert pipeline)
│   │   ├── lib/              # token encryption
│   │   └── config/           # env validation, CORS
│   └── migrations/           # 26 SQL migrations
└── restaurantiq-frontend/
    ├── src/
    │   ├── pages/            # Dashboard, Analytics, Margins, AI Assistant, Advisor, …
    │   ├── components/
    │   │   ├── charts/       # Recharts wrappers (revenue trend, heatmap, top items)
    │   │   ├── chat/         # MessageThread, Composer, DailyCapBanner
    │   │   └── advisor/      # ForecastTable, NarrativePanel, InsufficientHistoryList
    │   └── lib/              # API clients, Supabase client, hooks
    └── vercel.json
```

---

## Key engineering decisions

**Functional core / imperative shell for the forecast.** `buildForecast` is a pure TypeScript function: same inputs, same numbers, always. It can be unit-tested without mocking anything. Claude receives the output and writes prose. Token-priced arithmetic is the most expensive calculator ever built; the math runs in microseconds for free.

**Denormalized `restaurant_id` on `chat_messages`.** Redundant with the parent `chat_conversations.restaurant_id`, but lets the per-day cap count hit a single-table index and makes every tenancy check a one-clause WHERE. Storage is cheap; joins on the hot path aren't.

**CQRS in miniature on the advisor.** `GET /forecast` never recomputes — it's a cache read. `POST /forecast/refresh` is the only path that runs Claude, and it's rate-limited. Page-load cost and a 12-second wait during navigation are different failure modes; the button label "Generating…" is a feature.

**No ORM.** The schema is hand-written SQL — every index and constraint explicit — and application queries go through Supabase's PostgREST query builder rather than an ORM's entity graph (raw `pg` is reserved for the migration runner and the advisory-lock scheduler). The 26-migration history is the schema's changelog.

---

## Database schema

26 forward-only SQL migrations. Three Mermaid ER diagrams (core data, sync infrastructure, AI features) plus the design thought process — why multi-tenancy lives in a column, why daily summaries exist alongside raw orders, how the two-table sync architecture works, and why every token is stored as integer cents.

See [`docs/schema.md`](docs/schema.md).

---

## Bug log

17 documented bugs across the project — what broke, how it was diagnosed, what fixed it, and what the pattern tells you. Categories: React render timing, optimistic UI races, PostgREST quirks, Node module load order, distributed systems, deployment config, and schema edge cases.

See [`docs/bugs.md`](docs/bugs.md).

---

## Sprint history

Built across 20+ sprints. See [`docs/sprints-overview.md`](docs/sprints-overview.md) for the full log.

| Sprints | What shipped |
|---|---|
| A–C | Square integration, JWT auth, live dashboard, Claude insights, deterministic alerts |
| D–E | Recharts analytics (trend, heatmap, top items), AI marketing copy |
| F–G | Alerts hardening, browser push notifications, guided onboarding, empty states |
| H–I | Margin analysis, menu item cost entry (unlocks true profit per dish) |
| J–K | DoorDash as second order source, shared ingestion pipeline, OAuth token encryption, 95 tests |
| L–L+ | Automated sync scheduler, distributed leader election, durable job queue with retry/backoff |
| M–N | Deployment config, CORS, rate limiting, security headers, health endpoint, runbooks |
| O | Brand design system (Tailwind theme, SVG icons, landing page, auth shell) |
| P | AI Chat, Purchasing Advisor, password reset, first production deploy (Railway + Vercel) |
| Q–S | Cross-channel delivery-tax margins (what the owner keeps after DoorDash fees), revenue-labeling trust fixes, pilot-readiness hardening |
| T–U | Redesigned AI insight contract (typed priorities, expected impact, deep links per card), persistent insights with a review workflow, tenant-isolation test sweep across the route surface |

---

## Local development

**Prerequisites:** Node 18+, a Supabase project, Square sandbox credentials, Anthropic API key.

```bash
# Clone
git clone https://github.com/dy1an-nt/RestaurantIQ.git
cd RestaurantIQ

# Backend
cd restaurantiq-backend
cp .env.example .env          # fill in your keys
npm install
npm run build
npm start                     # http://localhost:3001

# Frontend (separate terminal)
cd restaurantiq-frontend
cp .env.example .env          # set VITE_API_URL=http://localhost:3001
npm install
npm run dev                   # http://localhost:5173
```

**Environment variables** — see `.env.example` in each package for the full list. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TOKEN_ENCRYPTION_KEY` (32-byte hex). Optional: `DATABASE_URL` (enables distributed leader election; omit for single-instance dev), `SQUARE_*`, `DOORDASH_*`.

**Running tests:**
```bash
cd restaurantiq-backend
npm test              # 18 suites, 279 tests
```

---

## Status & where this is going

RestaurantIQ is live (Railway + Vercel) and built solo, end to end — schema, backend, frontend, AI integration, deployment, and docs. It is not open for public sign-ups yet: the near-term goal is pilots with real restaurants, and the work toward that is tracked openly in [`docs/known-limitations.md`](docs/known-limitations.md) (the honest gap list shown to pilot candidates) and [`docs/pilot-checklist.md`](docs/pilot-checklist.md).

If a restaurant wants to see this on its own numbers or wants to talk about a pilot — reach out or open an issue.

This repo also doubles as my engineering portfolio, so it's written to show *how* it was built, not just what: the [sprint log](docs/sprints-overview.md), the [bug log](docs/bugs.md) (17 documented failures and what each one taught), the [schema design notes](docs/schema.md), and the deployment and operations runbooks are all part of the product.
