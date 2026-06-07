# RestaurantIQ

Restaurant analytics and marketing SaaS. Syncs with POS systems (Toast) and delivery apps (DoorDash), surfaces menu analytics, and generates AI-powered marketing copy.

## Project Overview

**MVP Scope:** Menu analytics + marketing copy only.
- Toast POS + DoorDash API integration for unified order data
- Analytics dashboard: top/bottom items by revenue, margin, time-of-day heatmaps, week-over-week trends
- AI insights via Claude API: plain English recommendations on what to promote, cut, or reprice
- Marketing copy generation: social captions, promo ideas based on item performance
- Alerts: item not selling, trending down 20%, new top performer

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Tailwind + Recharts + Vite |
| Backend | Node.js + Express |
| Database | PostgreSQL (Supabase) |
| AI | Anthropic Claude API |
| Hosting | Vercel (frontend) + Railway (backend) |

## Database Schema

```sql
restaurants
  id, name, location, pos_connected, delivery_connected,
  toast_guid, doordash_store_id, created_at

menu_items
  id, restaurant_id, name, category, price_cents, cost_cents,
  source (toast/doordash/manual), created_at

orders
  id, restaurant_id, source, total_cents, ordered_at, created_at

order_items
  id, order_id, menu_item_id, quantity, unit_price_cents

daily_summaries
  id, restaurant_id, menu_item_id, date, total_quantity,
  total_revenue_cents, total_orders

alerts
  id, restaurant_id, menu_item_id, type (no_sales/trending_down/new_top_performer),
  is_read, created_at
```

## Agent Team System

Seven specialized agents per sprint. Each owns a clear vertical slice.

### Agent Roles

**Architect Agent** (`claude` / lead)
- Goal format: "We are building [feature]. Produce the sprint plan: requirements, DB changes, API contract, edge cases, tenant isolation risks, scaling concerns, and success criteria."
- Owns: sprint design, API contract definition, risk identification
- Runs FIRST — backend and frontend must not start until the architect output is written
- Mandatory output: requirements, DB changes (if any), new services/files, full API contract with request/response examples, risks, success criteria

**Backend Agent** (`backend-agent`)
- Goal format: "Build [endpoint/service] per the architect contract. Accept [inputs], return [outputs]."
- Owns: Express routes, controllers, Postgres queries, API integrations (Square, DoorDash), cron jobs
- Coordination: posts full API contract (files changed, endpoints, request/response examples, error cases) when done — frontend must never inspect backend code to understand the API
- Mandatory output: files changed, DB changes, API endpoints with request + response examples, error cases

**Frontend Agent** (`frontend-agent`)
- Goal format: "Build [feature/component] that does [behavior]. User should be able to [interaction]."
- Owns: React components, Tailwind styling, Recharts visualizations, page layout, routing
- Coordination: waits for backend's API contract before wiring fetch calls
- Must handle: loading state, error state, empty state for every data-fetching component

**Security Agent** (`qa-agent` with security brief)
- Goal format: "Security review the [feature] backend routes. Check auth, multi-tenancy, input validation, secrets handling, and common attacks."
- Owns: adversarial review — not "does it work" but "how could it be abused"
- Runs after backend + frontend finish, before functional QA
- Checklist:
  - JWT validation present on every protected route
  - Every DB query scoped with `WHERE restaurant_id = ?` (no cross-tenant leakage)
  - No secrets or tokens in logs
  - Encrypted storage for OAuth tokens
  - Input validated at system boundaries
  - SQL injection, XSS, CSRF, authorization bypass surface checked

**QA Agent** (`qa-agent`)
- Goal format: "Verify [feature] end to end. Test happy path, invalid input, unauthorized user, wrong restaurant, empty dataset, large dataset."
- Owns: functional correctness, integration, schema mismatches, error + empty states
- Runs after Security Agent clears the backend
- Test cases required: happy path, invalid input, unauthorized user, wrong restaurant ID, empty data, edge-case data

**DevOps Agent** (`backend-agent` with devops brief)
- Goal format: "Produce the deployment checklist for this sprint."
- Owns: deployment impact assessment
- Runs after QA passes
- Mandatory output:
  - Files/services changed
  - New env vars (name, where to set in Railway/Vercel)
  - Migration required? (Yes/No — include SQL if yes)
  - Rollback plan if deployment fails

**Teaching Agent** (`teaching-agent`)
- Goal format: "After all agents finish, summarize the sprint. Explain it like I'm a CS student who wants to understand it deeply."
- Owns: `docs/weekly-summary/week-N.md` — one file per sprint
- Waits for: DevOps Agent output before writing
- Produces, for each sprint:
  - What each file does and why it exists
  - Key technical decisions and why they were made that way
  - Patterns or concepts used (e.g. "this uses the repository pattern because…")
  - What you should be able to explain in an interview about this week's work
  - What to look up if you want to go deeper

### Sprint Workflow

```
1. Architect Agent
   → produces: requirements, DB changes, API contract, risks, success criteria

2. Backend Agent + Frontend Agent (parallel)
   ├── backend-agent  → builds to contract → posts: files, endpoints, request/response, errors
   └── frontend-agent → builds UI shell   → wires fetch calls after backend contract lands

3. Security Agent
   → adversarial review of backend routes (auth, tenancy, secrets, attacks)
   → blocks QA if issues found

4. QA Agent
   → functional end-to-end: happy path, invalid input, wrong tenant, empty/large data

5. DevOps Agent
   → deployment checklist: env vars, migrations, rollback plan

6. Teaching Agent
   → writes docs/weekly-summary/week-N.md
```

## Code Conventions

- All monetary values stored and passed as cents (integers), formatted for display only
- API responses: `{ data: ..., error: null }` or `{ data: null, error: "message" }`
- restaurantId always required on protected routes (no multi-tenant leakage)
- Tailwind only — no custom CSS files
- Recharts for all data visualizations
- No console.log in committed code
