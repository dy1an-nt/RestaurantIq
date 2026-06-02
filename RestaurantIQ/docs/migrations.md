# Database Migration Workflow

Schema changes go through a tracked, repeatable runner. **Do not paste SQL into
the Supabase SQL editor for production changes** — that is unauditable, easy to
double-apply, and impossible to roll back consistently. Every schema change is a
numbered file in [`restaurantiq-backend/migrations/`](../restaurantiq-backend/migrations)
applied by the runner in [`src/scripts/migrate.ts`](../restaurantiq-backend/src/scripts/migrate.ts).

---

## How it works

- Migrations are `NNN_description.sql` files in `migrations/`, applied in
  **filename order**.
- The runner records every applied file in a `schema_migrations` table
  (`filename`, `checksum`, `applied_at`), so each migration runs **exactly once**.
- Each migration is applied inside a transaction **together with** its tracking
  row — they commit together or not at all. A failure rolls back and stops the
  run; no partial state.
- A stored `checksum` detects drift: if an already-applied file is later edited,
  `migrate:status` flags it. **Never edit an applied migration — add a new one.**

Commands (run from `restaurantiq-backend/`, with `DATABASE_URL` set):

```bash
npm run migrate           # apply all pending migrations
npm run migrate:status    # list applied vs pending; flag checksum drift
npm run migrate:baseline  # mark all current files as applied WITHOUT running them
npm run migrate -- --dry-run        # preview what `up` would apply
npm run migrate:baseline -- --dry-run
```

`DATABASE_URL` must be the **Postgres connection string** (Supabase: Settings →
Database → Connection string — direct/session on port 5432), not the REST URL.

---

## Authoring a migration

1. Create the next-numbered file, e.g. `migrations/021_add_widget_table.sql`.
2. Make it **idempotent where practical** (`IF NOT EXISTS`, `IF EXISTS`,
   `ON CONFLICT`) so a re-run on a fresh environment is safe.
3. You may keep the existing `BEGIN; ... COMMIT;` wrapper for readability and so
   the file also works if pasted manually in an emergency — the runner strips
   standalone `BEGIN;`/`COMMIT;` lines and supplies its own transaction.
4. Add a comment block describing the forward change and, importantly, **how to
   roll it back** (see below).
5. Commit the file. It is now part of the repeatable workflow.

---

## Local migration process

```bash
cd restaurantiq-backend
# .env has DATABASE_URL pointing at your local/dev Postgres (or a dev Supabase project)
npm run migrate:status     # see what's pending
npm run migrate -- --dry-run
npm run migrate            # apply
```

For a fresh local database, run `npm run migrate` from empty — every file applies
in order. (Note: a couple of early files are not idempotent, e.g. `002`'s
`RENAME COLUMN`; they assume the prior state, which a from-scratch run produces.)

---

## Staging process

If a staging Supabase project exists, treat it as a rehearsal for production:

```bash
DATABASE_URL=<staging connection string> npm run migrate:status
DATABASE_URL=<staging connection string> npm run migrate -- --dry-run
DATABASE_URL=<staging connection string> npm run migrate
```

Then run the app against staging and smoke-test the affected feature before
touching production. If there is no separate staging project, use a short-lived
Supabase branch or a scratch project restored from a recent backup.

---

## Production migration process

1. **Back up first.** Confirm a recent automated backup exists, or take a manual
   dump (see [operations.md](./operations.md#manual-logical-backups-defense-in-depth)).
   Migrations are forward-only; the backup is your real rollback for destructive
   changes.
2. **First time only — adopt the runner on the existing database.** The current
   production DB already had migrations `002`–`020` applied by hand. Tell the
   runner they're done so it doesn't re-run them (several are not idempotent):
   ```bash
   DATABASE_URL=<prod> npm run migrate:baseline -- --dry-run   # review
   DATABASE_URL=<prod> npm run migrate:baseline                # record as applied
   DATABASE_URL=<prod> npm run migrate:status                  # expect: 0 pending
   ```
3. **Subsequent deploys.** Apply only the new pending files:
   ```bash
   DATABASE_URL=<prod> npm run migrate:status
   DATABASE_URL=<prod> npm run migrate -- --dry-run
   DATABASE_URL=<prod> npm run migrate
   ```
4. Run `migrate:status` again — expect `0 pending` and no drift.
5. Deploy the application code that depends on the new schema.

> **Ordering with deploys:** prefer backward-compatible (expand → migrate →
> contract) changes. Add columns/tables before the code that uses them; only
> drop old columns in a later migration after the new code is fully deployed.
> This keeps the running app working during the deploy window.

---

## Rollback strategy

This runner is **forward-only** — there is no automatic "down". Roll back by
moving forward to a corrected state, which is safer and auditable:

- **Preferred — compensating migration.** Write a new numbered file that reverses
  the change (e.g. `022_revert_widget_table.sql` that drops what `021` added).
  Apply it like any other migration. The history stays linear and truthful.
- **Destructive change gone wrong — restore from backup.** If a migration
  dropped or corrupted data, a compensating migration cannot bring it back.
  Restore from the pre-migration backup per
  [operations.md → Database restoration](./operations.md#database-restoration-steps).
- **Migration failed mid-run.** It already rolled back atomically (nothing was
  recorded, schema unchanged). Fix the SQL in place — it was never applied, so
  editing it is fine — and re-run.

Because each authored migration documents its own rollback in its comment header,
the compensating file is usually quick to write.

---

## Why a custom runner (not the Supabase CLI)?

The Supabase CLI is a fine alternative and uses the same core idea (ordered files
+ a tracking table). This project ships a tiny runner instead because it:
- needs no extra tooling install (uses the `pg` dependency already present),
- works directly with the existing `migrations/NNN_*.sql` files and numbering,
- runs identically in local, CI, and production via `DATABASE_URL`.

If the team later standardizes on the Supabase CLI, migrate the files into
`supabase/migrations/` and use `supabase migration repair` to seed the tracking
table from the current `schema_migrations` state.
