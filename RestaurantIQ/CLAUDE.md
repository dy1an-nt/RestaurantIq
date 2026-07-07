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

Seven specialized agents per sprint. Each owns a clear vertical slice.

### Agent Roles

**Architect Agent** (`architect-agent`)
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

**DevOps Agent** (`devops-agent`)
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

### Orchestration protocol (main session)

Subagents share no memory — each one launches blank except for its definition
file. The main session is the message bus, and vague handoffs are where sprints
rot. Every agent prompt must be self-contained: the goal, exact file paths, the
pasted contract or finding, and the expected output format. An agent that has to
rediscover context burns usage re-reading the repo — expensive and error-prone.

1. **Architect first.** Launch `architect-agent` with the sprint goal. Save its
   full output; every later prompt quotes from it.
2. **Build in parallel, contracts pasted verbatim.** Launch `backend-agent` and
   `frontend-agent` together, each with the relevant contract sections *pasted
   into the prompt*. "Per the architect's plan" is meaningless to an agent that
   never saw the plan.
3. **Gate between build and QA.** `npx tsc --noEmit` must be clean in both
   packages, and the backend agent's posted API contract captured, before QA
   launches. If either fails, fix first.
4. **QA with evidence in hand.** Launch `qa-agent` (security brief first, then
   functional) with the changed-file list and the architect's success criteria
   pasted in.
5. **Findings loop.** A Critical finding goes back to the build agent with the
   finding quoted verbatim; QA re-checks the fix. A sprint with an open Critical
   is not done — no exceptions.
6. **Close out.** `devops-agent`, then `teaching-agent`, each given the file list
   and the prior outputs they depend on.

### Lightweight path for small fixes

The full pipeline is for sprints. For single-file bug fixes, doc updates, and
small refactors, work **directly in the main session — no subagents** — holding
yourself to the Operating Discipline gates above plus the invariants in the
relevant build agent's definition (`.claude/agents/backend-agent.md` /
`frontend-agent.md`). The QA spot-check is also yours: run the QA agent's grep
sweep over what you touched (`console.log`, `parseFloat`/float math on money,
`req.user` scoping, `useEffect` cancellation) before calling it done. Spawning
agents costs real usage; spend it where isolation or an adversarial second
reader actually adds something. One exception is not negotiable: anything
touching auth, tenant scoping, or money handling gets a real `qa-agent`
security pass regardless of size.

## Code Conventions

- All monetary values stored and passed as cents (integers), formatted for display only
- API responses: `{ data: ..., error: null }` or `{ data: null, error: "message" }`
- restaurantId always required on protected routes (no multi-tenant leakage)
- Tailwind only — no custom CSS files
- Recharts for all data visualizations
- No console.log in committed code
- Known pitfalls live in `docs/sharp-edges.md` (canonical) with full war stories in `docs/bugs.md` — new pattern-level bugs get recorded there, not in agent definitions
