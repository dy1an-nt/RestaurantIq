# Operations: Backup, Recovery & Disaster Recovery

This document covers how RestaurantIQ's data and services are backed up, how to
recover them, and how to verify that recovery actually works. It is written so an
on-call operator with no prior context can act during an incident.

Companion docs:
- [deployment.md](./deployment.md) — how the two services are deployed.
- [migrations.md](./migrations.md) — how schema changes reach production.

---

## What needs protecting

| Asset | Where it lives | Backed up by | Blast radius if lost |
| ----- | -------------- | ------------ | -------------------- |
| Application data (orders, menu items, summaries, alerts) | Supabase Postgres | Supabase automated backups + manual dumps | Total — this is the product |
| Database schema | Supabase Postgres | Git (`migrations/`) | Recoverable from migrations |
| Backend secrets (API keys, encryption keys) | Railway env vars | **Operator-held password manager** | Integrations + encrypted tokens unreadable |
| Frontend config | Vercel env vars | Git `.env.example` + password manager | Frontend points at wrong/no backend |
| Integration tokens (Square/DoorDash) | Supabase, encrypted at rest | Same as application data | Re-auth required if encryption key also lost |

> **Critical coupling:** integration tokens are encrypted with
> `ACTIVE_TOKEN_ENCRYPTION_KEY`. A database restore is useless for those rows if
> the encryption key is lost. Back up the key with the same rigor as the
> database (see [Environment variable recovery](#environment-variable-recovery)).

---

## Supabase backup strategy

### Automated backups

Supabase takes automated backups of the Postgres database. Behavior depends on
the project's plan:

- **Pro plan and above:** daily automated backups with point-in-time recovery
  (PITR) available as an add-on. PITR lets you restore to any moment within the
  retention window (not just the last nightly snapshot).
- **Free plan:** backups are limited; **do not run production on Free.** Upgrade
  to Pro before going live so daily backups and PITR are available.

Where to confirm/configure:
**Supabase Dashboard → Project → Database → Backups.**

Action items for production readiness:
- [ ] Project is on Pro (or higher).
- [ ] Daily backups are enabled and listed in the Backups tab.
- [ ] PITR add-on enabled if the RPO (below) requires sub-day recovery.
- [ ] Retention window documented and meets the business requirement.

### Recovery objectives

Agree on these explicitly; they drive the plan above.

- **RPO (Recovery Point Objective)** — how much data loss is tolerable. With
  daily backups, worst case is ~24h. With PITR, minutes.
- **RTO (Recovery Time Objective)** — how long recovery may take. A Supabase
  restore is typically minutes-to-tens-of-minutes depending on data size.

### Manual logical backups (defense in depth)

Automated backups live inside the Supabase project. For an extra, portable copy
that survives even a project-level disaster, take periodic logical dumps with
`pg_dump` using the **direct connection string** (the same `DATABASE_URL` family
used by the scheduler — port 5432):

```bash
# Full logical backup (schema + data), custom format for selective restore.
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="riq-backup-$(date +%Y%m%d-%H%M).dump"

# Store it off-platform (e.g. encrypted object storage). Treat it as sensitive:
# it contains all customer data and encrypted integration tokens.
```

Schedule this (cron / CI scheduled job) at a cadence matching your RPO, and
upload the artifact to storage outside Supabase.

### Backup verification

A backup you've never restored is a hope, not a backup. Verify on a schedule
(e.g. monthly):

1. Spin up a throwaway Postgres (local Docker or a scratch Supabase project).
2. Restore the most recent dump into it:
   ```bash
   pg_restore --no-owner --no-privileges --dbname "$SCRATCH_DATABASE_URL" \
     riq-backup-YYYYMMDD-HHMM.dump
   ```
3. Run smoke queries and confirm row counts are sane:
   ```sql
   select count(*) from restaurants;
   select count(*) from orders;
   select max(date) from daily_summaries;
   ```
4. Confirm the latest data is present (recent `created_at` / `date`).
5. Record the verification date and result. Tear the scratch instance down.

For Supabase's own automated backups, periodically use the **Restore to a new
project** flow (see below) and run the same smoke queries.

---

## Disaster recovery

### Database restoration steps

**Option A — Restore from a Supabase automated backup (preferred):**

1. Supabase Dashboard → Database → Backups.
2. Choose the target backup (or a PITR timestamp).
3. Restore. For safety, restore to a **new project** first, validate, then cut
   over — avoid overwriting the only surviving copy until the restore is proven.
4. If you restored to a new project, update `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL` in Railway, and
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in Vercel, then redeploy both.

**Option B — Restore from a manual `pg_dump`:**

1. Provision a fresh Postgres / Supabase project.
2. `pg_restore` the dump (command above).
3. Re-point and redeploy services as in Option A, step 4.

After either option, run the [Post-restore verification](#post-restore-verification).

### Environment variable recovery

Secrets are **not** in the database and **not** in git. They must be recoverable
independently:

- Keep the canonical copy of all production secrets in a shared password manager
  (1Password/Bitwarden/etc.), grouped per environment.
- The authoritative *list* of variables (names + purpose, no values) lives in:
  - Backend: [`restaurantiq-backend/.env.example`](../restaurantiq-backend/.env.example)
  - Frontend: [`restaurantiq-frontend/.env.example`](../restaurantiq-frontend/.env.example)
- **Token encryption keys** (`ACTIVE_TOKEN_ENCRYPTION_KEY`,
  `LEGACY_TOKEN_ENCRYPTION_KEYS`) are the highest-stakes secrets: without the
  active (or matching legacy) key, encrypted Square/DoorDash tokens in a restored
  database cannot be decrypted and every integration must be re-connected. Store
  them in the password manager and never rotate the active key without first
  moving the old key into the legacy list.

Recovery procedure:
1. From the password manager, re-create the variable set in Railway (backend) and
   Vercel (frontend) using `.env.example` as the checklist.
2. Redeploy both services so the new values take effect.
3. If encryption keys were lost entirely, expect to re-authenticate every
   integration after restore.

### Redeployment process

If the services (not the data) are lost, both redeploy from git — they are
stateless:

1. **Backend (Railway):** redeploy the `restaurantiq-backend` service from the
   current `main`. Confirm env vars are present, then verify startup (it
   fail-fasts on missing required vars).
2. **Frontend (Vercel):** redeploy `restaurantiq-frontend` from `main` with
   `VITE_*` vars set. Remember Vite inlines `VITE_API_URL` at build time — a
   redeploy is required after any change.
3. Run the post-deployment checklist in [deployment.md](./deployment.md#post-deployment-checklist).

### Post-restore verification

After any restore + redeploy, confirm the system is actually healthy:

- [ ] `curl https://<backend>/health` returns `{"status":"ok",...}`.
- [ ] Log in via the frontend — authentication works.
- [ ] Dashboard loads and shows expected data (row counts match pre-incident).
- [ ] AI insights endpoint returns a result (proves `ANTHROPIC_API_KEY`).
- [ ] An integration sync runs, or tokens decrypt (proves encryption key intact).
- [ ] No CORS errors in the browser console (proves `FRONTEND_URL` correct).
- [ ] Record incident timeline, what was restored, and actual RPO/RTO achieved.

---

## Incident quick reference

| Symptom | First check |
| ------- | ----------- |
| Backend won't boot | Railway logs — fail-fast prints the missing/invalid env var |
| 500s on AI endpoints | `ANTHROPIC_API_KEY` set? Rate limit (429, not 500)? Anthropic status? |
| Frontend can't reach API | `VITE_API_URL` correct + redeployed? `FRONTEND_URL` allowlist? |
| Integrations failing after restore | Token encryption key present and matching? |
| Data missing/stale | Check `daily_summaries.max(date)`; consider restore from backup |
