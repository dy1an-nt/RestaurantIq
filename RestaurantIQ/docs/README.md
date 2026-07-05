# RestaurantIQ Docs

Documentation for how RestaurantIQ is designed, built, operated, and where it's headed. Start with the [main README](../README.md) for the product overview and the story behind the project.

## Design & architecture

| Doc | What's in it |
|---|---|
| [`schema.md`](schema.md) | Database design: three Mermaid ER diagrams (core data, sync infrastructure, AI features) plus the reasoning — why multi-tenancy lives in a column, why daily summaries exist alongside raw orders, why money is integer cents |
| [`migrations.md`](migrations.md) | How the forward-only SQL migration system works and how to add a migration |

## Build history

| Doc | What's in it |
|---|---|
| [`sprints-overview.md`](sprints-overview.md) | Running log of every sprint, A through U — 3–4 bullets each |
| [`weekly-summary/`](weekly-summary/) | Deep-dive write-ups per sprint: what changed, why, and the patterns worth understanding |
| [`bugs.md`](bugs.md) | 17 documented bugs — what broke, how it was diagnosed, the fix, and the lesson |
| [`sharp-edges.md`](sharp-edges.md) | Canonical checklist of pitfalls distilled from the bug log — the doc every agent reads before touching code |
| [`agent-teams-reference.md`](agent-teams-reference.md) | Reference guide for the Claude Code agent-team workflow this project is developed with (architect → build → security → QA → devops → teaching) |

## Running it

| Doc | What's in it |
|---|---|
| [`deployment.md`](deployment.md) | Railway + Vercel deployment guide: env vars, CORS wiring, build/start commands |
| [`operations.md`](operations.md) | Backup, recovery, and disaster-recovery runbook — written so an on-call operator with no prior context can act |

## Toward real restaurants

| Doc | What's in it |
|---|---|
| [`known-limitations.md`](known-limitations.md) | The honest gap list — what pilot restaurants should know before relying on the numbers |
| [`pilot-checklist.md`](pilot-checklist.md) | Everything needed to onboard a pilot restaurant |
