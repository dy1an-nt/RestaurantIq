# RestaurantIQ

Restaurant analytics and marketing SaaS. Syncs with POS systems (Square) and delivery apps (DoorDash), surfaces menu analytics, and generates AI-powered marketing copy.

## Project Overview

**Shipped scope.** The original MVP was menu analytics plus marketing copy. The
product has grown past that, so do not treat anything below as out of scope
without checking `restaurantiq-backend/src/routes/` and
`restaurantiq-frontend/src/pages/` first.

- Square POS + DoorDash ingestion into unified order data, on a background sync
  scheduler with leader election and retry
- Analytics dashboard: top/bottom items by revenue, margin, time-of-day heatmaps, week-over-week trends
- Channel margin and delivery economics
- Alerts: item not selling, trending down 20%, new top performer
- AI insights via Claude API: persisted recommendations on what to promote, cut, or reprice
- Advisor chat over the restaurant's own data
- Marketing copy generation: social captions, promo ideas based on item performance

**DoorDash is not production-verified.** The Marketplace order and menu endpoints
are partner-gated, so `services/doordash/doordashClient.ts` talks to a
configurable base URL and, in mock mode, returns a deterministic fixture set.
Square is the integration with a real sandbox behind it. Do not write docs or
copy that imply a live DoorDash merchant connection.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Tailwind + Recharts + Vite |
| Backend | Node.js + Express |
| Database | PostgreSQL (Supabase) |
| AI | Anthropic Claude API |
| Hosting | Vercel (frontend) + Render (backend, `render.yaml` at repo root) |

## Operating Discipline

These rules encode how the strongest sessions on this project worked, written down
as procedure so quality does not depend on which model runs the session. They bind
the **main session** as much as any subagent. Follow them mechanically, especially
when a step feels unnecessary. That feeling is exactly what they exist to override.

### Before the first edit of a session

- Read `docs/sharp-edges.md` in full. It is short and it pays for itself on almost every task.
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
  formatting churn, or "while I'm here" fixes. List those as suggestions instead.
- If a second bug surfaces mid-task, report it; don't silently expand the diff.

### Hard gates before claiming done

Work is not done until every line below is true. If a gate failed or couldn't run,
the summary must say so explicitly. "Should work" is a banned phrase.

1. `npx tsc --noEmit` exits 0 in every package touched
   (`restaurantiq-backend/`, `restaurantiq-frontend/`).
2. `npm run lint` exits 0 in every package touched. Both packages run ESLint with
   `--max-warnings 0`, so a warning is a failure.
3. Backend changes: `npm test` passes. Run the whole suite, it is fast. If the
   change touches auth, tenant scoping, money, tokens, or the sync scheduler,
   assume a spec already exists under `src/**/__tests__/` and go find it. A
   behavior change needs a test added or changed, not just a green run.
4. Frontend changes: `npm run build` exits 0. `tsc --noEmit` alone does not catch
   a broken Vite build.
5. The changed flow was **exercised, not just compiled**: hit the endpoint with
   `curl`, load the page. If it wasn't run, the summary states exactly what
   wasn't run and why.
6. The full diff was re-read top to bottom after the last edit.
7. Invariants re-checked against the diff: tenant scoping present, `{ data, error }`
   shape intact, money still integer cents, any migration numbered + idempotent.
8. Schema changes went through the tracked runner (the `/migrate` skill), not the
   Supabase SQL editor. `docs/migrations.md` forbids hand-applied SQL for
   production. If SQL was applied by hand anyway, the summary says so in its own
   paragraph, every time, and says why the runner was not used.

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

[`docs/schema.md`](docs/schema.md) is canonical, and the numbered files in
`restaurantiq-backend/migrations/` are the ground truth behind it. Read the
relevant migration before writing a query or a new migration. Do not trust a
table list pasted into an instruction file, including this one, because that is
exactly the copy that goes stale.

The invariants outlive any particular table:

- Every tenant-scoped table carries `restaurant_id`, and every query filters on it
- Money is integer cents at rest and in transit, never a float
- Square and DoorDash OAuth tokens are AES-256-GCM encrypted at rest
- Migrations are forward-only, numbered, and idempotent

## Agent Team System

Seven sprint roles (architect → backend + frontend → security → QA → devops →
teaching), filled by the six definitions in `.claude/agents/`: `qa-agent` runs
twice, once with a security brief and once for functional QA. Orchestrated from
the main session as the message bus.
The full playbook lives in the **`/sprint` skill** (repo-root
`.claude/skills/sprint/SKILL.md`). It covers agent roles, goal formats, workflow
order, and the orchestration protocol (self-contained prompts, contracts pasted
verbatim, tsc gate before QA, findings loop, close-out). Invoke that skill
before launching any sprint; never run a sprint from memory of it. Agent
definitions live in `.claude/agents/`. Migration authoring/applying procedure is
the **`/migrate` skill** (backed by `docs/migrations.md`).

### Lightweight path for small fixes

The full pipeline is for sprints. For single-file bug fixes, doc updates, and
small refactors, work **directly in the main session, with no subagents**,
holding yourself to the Operating Discipline gates above plus the invariants in
the relevant build agent's definition (`.claude/agents/backend-agent.md` /
`frontend-agent.md`). The QA spot-check is also yours: run the **`/qa-sweep`
skill** (the QA agent's grep sweep: `console.log`, float math on money,
`req.user` scoping, `useEffect` cancellation) over what you touched before
calling it done. Spawning agents costs real usage; spend it where isolation or
an adversarial second reader actually adds something. One exception is not
negotiable: anything touching auth, tenant scoping, or money handling gets a
real `qa-agent` security pass regardless of size.

## Code Conventions

- All monetary values stored and passed as cents (integers), formatted for display only
- API responses: `{ data: ..., error: null }` or `{ data: null, error: "message" }`
- restaurantId always required on protected routes (no multi-tenant leakage)
- Tailwind only, no custom CSS files
- Recharts for all data visualizations
- No console.log in committed code
- No em dashes in any prose written for this repo: docs, README, commit messages, PR descriptions, code comments, and user-facing copy. Use a period or a comma. Parentheses and en dashes are not a workaround; if a thought needs separation, end the sentence. The `/unslop` skill carries the full prose rules
- Known pitfalls live in `docs/sharp-edges.md` (canonical) with full war stories in `docs/bugs.md`. New pattern-level bugs get recorded there, not in agent definitions
