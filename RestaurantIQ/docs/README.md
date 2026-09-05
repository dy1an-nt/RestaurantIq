# RestaurantIQ Docs

Documentation for how RestaurantIQ is designed, operated, and improved. Start with the repository-root [README](../../README.md) for the product overview, engineering decisions, and local setup.

## Architecture and engineering

| Doc | What's in it |
|---|---|
| [`schema.md`](schema.md) | Database diagrams and the reasoning behind multi-tenancy, aggregates, sync state, and integer-cents money handling |
| [`migrations.md`](migrations.md) | How the forward-only SQL migration system works and how to add a migration |
| [`bugs.md`](bugs.md) | Notable failures, diagnoses, fixes, and the engineering lessons that followed |
| [`sharp-edges.md`](sharp-edges.md) | Current implementation pitfalls distilled from the bug log |

## Engineering case studies

| Case study | Decision |
|---|---|
| [`distributed-sync.md`](case-studies/distributed-sync.md) | Leader election, per-integration locking, durable retries, and failure recovery |
| [`financial-correctness.md`](case-studies/financial-correctness.md) | Integer-cents arithmetic, missing-cost semantics, fee allocation, and tenant-safe reads |
| [`deterministic-ai-forecasting.md`](case-studies/deterministic-ai-forecasting.md) | Deterministic forecasting with an LLM limited to explanation |
| [`tenant-isolation.md`](case-studies/tenant-isolation.md) | Central tenant resolution, route-level adversarial tests, and an RLS backstop |

## Product and pilot readiness

| Doc | What's in it |
|---|---|
| [`known-limitations.md`](known-limitations.md) | Current data, product, testing, and operational constraints |
| [`pilot-checklist.md`](pilot-checklist.md) | Go/no-go gates and onboarding steps for a small restaurant pilot |
| [`competitive-landscape.md`](competitive-landscape.md) | Product positioning against Toast and the cross-source analytics gap |

## Deployment and operations

| Doc | What's in it |
|---|---|
| [`deployment.md`](deployment.md) | Render + Vercel deployment guide: env vars, CORS wiring, build/start commands |
| [`operations.md`](operations.md) | Backup, recovery, and disaster-recovery runbook |

## Historical build record

| Doc | What's in it |
|---|---|
| [`sprints-overview.md`](sprints-overview.md) | Concise history of what changed across the project's sprints |
| [`archive/sprint-notes/`](archive/sprint-notes/) | Detailed historical sprint notes retained without remaining on the primary reading path |

Internal development-tool references are intentionally excluded from this public documentation path.
