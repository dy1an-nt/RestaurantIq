# RestaurantIQ

Restaurant analytics and marketing SaaS. Syncs with POS systems (Square) and delivery apps (DoorDash), surfaces menu analytics, and generates AI-powered marketing copy.

## Project Overview

**MVP Scope:** Menu analytics + marketing copy only.
- Square POS + DoorDash API integration for unified order data
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

## Operating Discipline

These rules encode how the strongest sessions on this project worked, written down
as procedure so quality does not depend on which model runs the session. They bind
the **main session** as much as any subagent. Follow them mechanically — especially
when a step feels unnecessary; that feeling is exactly what they exist to override.

### Before the first edit of a session

- Read `docs/sharp-edges.md` (~60 lines). It pays for itself on almost every task.
- If the task names a file, read that file **and its immediate neighbors** (route ↔
  controller ↔ service, or page ↔ context) before proposing anything.

### Before any edit

- **Read the file you are editing, in this session, first.** Never edit from memory
  of a file or from what another file implies about it.
- **Copy an existing pattern.** Find the closest existing route / controller /
  component and match its shape. Consistency is a feature of this codebase; novel
  structure needs a stated reason.
- **Never invent an API.** Before calling any function, endpoint, or library method
  not read in this session: read its definition, or confirm the dependency exists in
  `package.json`. If it can't be verified, say so instead of guessing.

### Scope

- Smallest diff that solves the stated problem. No drive-by refactors, renames,
  formatting churn, or "while I'm here" fixes — list those as suggestions instead.
- If a second bug surfaces mid-task, report it; don't silently expand the diff.

### Hard gates before claiming done

Work is not done until every line below is true. If a gate failed or couldn't run,
the summary must say so explicitly — "should work" is a banned phrase.

1. `npx tsc --noEmit` exits 0 in every package touched
   (`restaurantiq-backend/`, `restaurantiq-frontend/`).
2. The changed flow was **exercised, not just compiled** — hit the endpoint with
   `curl`, load the page — or the summary states exactly what wasn't run and why.
3. The full diff was re-read top to bottom after the last edit.
4. Invariants re-checked against the diff: tenant scoping present, `{ data, error }`
   shape intact, money still integer cents, any migration numbered + idempotent.
5. If manual SQL must be run in the Supabase SQL editor, the summary says so in its
   own paragraph — every time, even if mentioned earlier.

### Reporting

- Lead with the outcome ("Fixed X; the cause was Y"), then supporting detail.
- Quote real command output for claims; paraphrased test results don't count.
  Failures are reported as failures, not softened.

### When stuck

- Two failed attempts at the same fix = stop. Re-read the actual error text and
  `docs/sharp-edges.md`, then re-derive the cause from evidence before attempt
  three. Never loop on variations of a guess.
- Prefer answering questions with `grep` / reading / `curl` over asking the user.
  Ask only for genuinely user-owned decisions: product scope, spending money,
  destructive or irreversible operations.

## Database Schema

```sql
restaurants
  id, name, location, pos_connected, delivery_connected,
  square_location_id, doordash_store_id, created_at

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

Seven specialized agents per sprint (architect → backend + frontend → security →
QA → devops → teaching), orchestrated from the main session as the message bus.
The full playbook — agent roles, goal formats, workflow order, and the
orchestration protocol (self-contained prompts, contracts pasted verbatim, tsc
gate before QA, findings loop, close-out) — lives in the **`/sprint` skill**
(repo-root `.claude/skills/sprint/SKILL.md`). Invoke that skill before launching
any sprint; never run a sprint from memory of it. Agent definitions live in
`.claude/agents/`. Migration authoring/applying procedure is the **`/migrate`
skill** (backed by `docs/migrations.md`).

### Lightweight path for small fixes

The full pipeline is for sprints. For single-file bug fixes, doc updates, and
small refactors, work **directly in the main session — no subagents** — holding
yourself to the Operating Discipline gates above plus the invariants in the
relevant build agent's definition (`.claude/agents/backend-agent.md` /
`frontend-agent.md`). The QA spot-check is also yours: run the **`/qa-sweep`
skill** (the QA agent's grep sweep — `console.log`, float math on money,
`req.user` scoping, `useEffect` cancellation) over what you touched before
calling it done. Spawning agents costs real usage; spend it where isolation or
an adversarial second reader actually adds something. One exception is not
negotiable: anything touching auth, tenant scoping, or money handling gets a
real `qa-agent` security pass regardless of size.

## Code Conventions

- All monetary values stored and passed as cents (integers), formatted for display only
- API responses: `{ data: ..., error: null }` or `{ data: null, error: "message" }`
- restaurantId always required on protected routes (no multi-tenant leakage)
- Tailwind only — no custom CSS files
- Recharts for all data visualizations
- No console.log in committed code
- Known pitfalls live in `docs/sharp-edges.md` (canonical) with full war stories in `docs/bugs.md` — new pattern-level bugs get recorded there, not in agent definitions
