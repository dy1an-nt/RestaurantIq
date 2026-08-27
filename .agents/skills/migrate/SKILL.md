---
name: migrate
description: Author and apply a RestaurantIQ database migration through the tracked runner. Use whenever a schema change is needed (new table/column/constraint/index) or when migrations must be applied to local, staging, or production — "add a migration", "run migrations", "apply 026 to prod". Never paste SQL into the Supabase SQL editor for production changes.
---

# Database Migrations

Canonical doc: `RestaurantIQ/docs/migrations.md` — read it for staging process,
first-time baseline adoption, and rollback detail. This is the working checklist.

Schema changes are numbered `NNN_description.sql` files in
`RestaurantIQ/restaurantiq-backend/migrations/`, applied **in filename order** by
the runner (`src/scripts/migrate.ts`), which records each file (with checksum)
in `schema_migrations` so it runs exactly once. **Never edit an applied
migration — add a new one.** The runner is forward-only: roll back with a
compensating migration, or restore from backup for destructive mistakes.

## Authoring

1. Create the next-numbered file (check `ls migrations/ | tail` for the number).
2. Idempotent where practical: `IF NOT EXISTS`, `IF EXISTS`, `ON CONFLICT`.
3. Keep the `BEGIN; ... COMMIT;` wrapper (the runner strips it and supplies its
   own transaction; the wrapper keeps the file safe if ever pasted manually).
4. Comment header: what it changes and **how to roll it back**.
5. Sharp edges that have bitten before:
   - Adding a value to an enum-style column (`source`, `type`) requires
     migrating the named CHECK constraint (`DROP CONSTRAINT IF EXISTS … ADD`).
   - `upsert` + partial unique indexes don't mix — use a regular `UNIQUE`
     constraint if the code upserts with `onConflict`.
   - PostgREST embeds need real FK constraints, not matching column names.

## Applying

Run from `RestaurantIQ/restaurantiq-backend/` with `DATABASE_URL` set — the
**Postgres connection string** (Supabase: Settings → Database → direct/session,
port 5432), not the REST URL.

```bash
npm run migrate:status              # applied vs pending; flags checksum drift
npm run migrate -- --dry-run        # preview
npm run migrate                     # apply all pending
```

Production order: confirm a recent backup exists → `migrate:status` →
`--dry-run` → `migrate` → `migrate:status` again (expect 0 pending, no drift) →
then deploy the code that depends on the schema. Prefer expand → migrate →
contract so the running app survives the deploy window.

## Reporting

Per the Operating Discipline hard gates: if the migration has not yet been
applied to an environment (staging, production), the task summary must say so
in its own paragraph — every time.
