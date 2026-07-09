---
name: sprint
description: Run a full RestaurantIQ sprint with the seven-agent team (architect → backend + frontend → security → QA → devops → teaching). Use when building a feature or any multi-file vertical slice — "run a sprint", "build [feature]", "Sprint V". NOT for single-file bug fixes, doc updates, or small refactors; those stay in the main session per CLAUDE.md's lightweight path (use /qa-sweep before calling them done).
---

# Sprint Playbook

Seven specialized agents per sprint. Each owns a clear vertical slice. The main
session (you) is the orchestrator and message bus. Agent definitions live in
`.claude/agents/`; this file is the protocol for running them.

Before launching anything: read `RestaurantIQ/docs/sharp-edges.md` and the
Operating Discipline in `RestaurantIQ/CLAUDE.md` — its hard gates apply to the
sprint as a whole, not just to individual agents.

## Agent Roles

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

## Sprint Workflow

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

## Orchestration protocol (main session)

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
   and the prior outputs they depend on. A sprint is not closed until the
   week-N summary exists and any new migration has been applied per /migrate
   (or the summary states in its own paragraph that it still must be).
