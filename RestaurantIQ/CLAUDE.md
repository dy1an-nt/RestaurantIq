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

Four specialized agents per sprint. Each owns a clear vertical slice.

### Agent Roles

**Frontend Agent** (`frontend-agent`)
- Goal format: "Build [feature/component] that does [behavior]. User should be able to [interaction]."
- Owns: React components, Tailwind styling, Recharts visualizations, page layout, routing
- Coordination: waits for backend's API contract message before wiring fetch calls

**Backend Agent** (`backend-agent`)
- Goal format: "Build [endpoint/service] that [does what]. It should accept [inputs] and return [outputs]."
- Owns: Express routes, controllers, Postgres queries, API integrations (Square, DoorDash), cron jobs
- Coordination: messages frontend agent with full API contract when an endpoint is ready

**QA + Integration Agent** (`qa-agent`)
- Goal format: "Verify that [feature] works end to end. Test [these cases]. Fix anything broken between frontend and backend."
- Owns: connecting frontend to backend, schema mismatches, error states, edge cases, empty states
- Runs after both frontend and backend agents complete their sprint work

**Teaching Agent** (`teaching-agent`)
- Goal format: "After all three agents finish and QA passes, summarize everything that was built this sprint. Explain it like I'm a CS student who wants to understand it deeply, not just use it."
- Owns: `docs/weekly-summary/week-N.md` — one file per sprint
- Waits for: QA agent to confirm everything passes before writing
- Produces, for each sprint:
  - What each file does and why it exists
  - Key technical decisions and why they were made that way
  - Any patterns or concepts used (e.g. "this uses the repository pattern because…")
  - What you should be able to explain in an interview about this week's work
  - What to look up if you want to go deeper

### Sprint Workflow

```
Lead spawns:
  ├── backend-agent  →  builds endpoint  →  messages frontend-agent with API contract
  └── frontend-agent →  builds UI shell  →  waits for API contract, then wires fetch calls

After both finish:
  └── qa-agent → verifies end-to-end, fixes integration issues, reports back to lead

After QA passes:
  └── teaching-agent → writes docs/weekly-summary/week-N.md explaining the sprint deeply
```

## Code Conventions

- All monetary values stored and passed as cents (integers), formatted for display only
- API responses: `{ data: ..., error: null }` or `{ data: null, error: "message" }`
- restaurantId always required on protected routes (no multi-tenant leakage)
- Tailwind only — no custom CSS files
- Recharts for all data visualizations
- No console.log in committed code
