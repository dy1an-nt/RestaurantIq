# Pilot Checklist

> Everything required to onboard the first 2–3 real restaurants and run the pilot
> safely. This is the operational runbook for the pilot; it points to the deeper
> docs rather than duplicating them:
> [`deployment.md`](deployment.md) · [`operations.md`](operations.md) ·
> [`migrations.md`](migrations.md) · [`known-limitations.md`](known-limitations.md).

---

## 0. Go / no-go gates

Do not start the pilot until all of these are true:

- [ ] CI is green on `main` (backend typecheck · lint · test · audit; frontend
      typecheck · lint · audit).
- [ ] Supabase project is on the **Pro plan** (Free has no production-grade
      backups — see operations.md).
- [ ] A **restore drill** has been completed at least once (§4).
- [ ] All required environment variables set in Railway + Vercel (§1).
- [ ] At least one end-to-end dry run on a sandbox restaurant (§5) passed.

---

## 1. Environment configuration

Full reference + behavior: [`deployment.md`](deployment.md). Quick verification list:

### Backend (Railway)
- [ ] `SUPABASE_URL` — required; server refuses to start without it.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — required.
- [ ] `ANTHROPIC_API_KEY` — required.
- [ ] `TOKEN_ENCRYPTION_KEY` — **required to store integration tokens.** 64-char
      hex. ⚠️ Not fail-fast validated at boot (see known-limitations) — confirm it
      is set *before* connecting any restaurant, or token storage fails at runtime.
- [ ] `SUPABASE_JWT_SECRET` — recommended (HS256 fallback if JWKS is unavailable).
- [ ] `SQUARE_ENVIRONMENT` — `production` for real restaurants (not `sandbox`).
- [ ] `FRONTEND_URL` — the deployed Vercel origin (CORS allow-list).
- [ ] `DATABASE_URL` — set only if running >1 backend instance (leader election).
      If unset, run **exactly one** backend instance (see rate-limit note below).
- [ ] `RATE_LIMIT_*` / `CHAT_DAILY_MESSAGE_CAP` — defaults are fine; confirm they
      suit pilot volume.

### Frontend (Vercel)
- [ ] `VITE_API_URL` — the deployed backend URL, no trailing slash.
- [ ] `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — public anon key only.

### Topology note
- [ ] Because rate limiting is in-memory (known-limitations / review M4), run a
      **single backend instance** for the pilot unless `DATABASE_URL` is set and
      you've accepted the per-instance limiter behavior.

---

## 2. Database & migrations

- [ ] `npm run migrate:status` shows all 25 migrations applied on the pilot DB.
- [ ] Row Level Security backstop is enabled (default-deny) — see schema docs.
- [ ] Procedure for applying new migrations during the pilot: [`migrations.md`](migrations.md).

---

## 3. Monitoring during the pilot

There is **no integrated error tracking / uptime alerting yet** (known-limitations).
Until there is, monitor manually on a daily cadence:

- [ ] **Backend health:** `GET /health` returns 200 (Railway healthcheck).
- [ ] **Sync health:** enable developer mode (Settings → Developer) and watch the
      **Sync Health** page — last-success times, retry counts, error messages per
      provider, per restaurant.
- [ ] **Logs:** scan Railway logs for `error`-level structured JSON daily.
- [ ] **AI cost:** check Anthropic usage against expectations (chat + insights are
      rate-limited, but watch for anomalies).
- [ ] **Data freshness:** each restaurant's dashboard shows "Last synced"; an amber
      stale warning means a sync has lapsed >24h — investigate.

---

## 4. Backups & restore verification

Full procedure: [`operations.md`](operations.md). For the pilot:

- [ ] Supabase **daily backups enabled**; PITR add-on enabled if sub-day RPO is
      required.
- [ ] Take a **manual logical backup** (`pg_dump … --format=custom`) and store it
      off-platform (encrypted).
- [ ] **Restore drill (required before go-live):** restore the latest dump into a
      scratch database and confirm row counts for `orders`, `menu_items`,
      `daily_summaries`. A backup you've never restored is a hope, not a backup.
- [ ] Note: a DB restore **cannot** decrypt integration tokens without the matching
      `TOKEN_ENCRYPTION_KEY` — back up that key separately and securely.

---

## 5. Per-restaurant onboarding (dry run + real)

For each pilot restaurant:

- [ ] Owner signs up and completes onboarding (create restaurant → connect Square →
      run first sync). The onboarding screen now explains where to find the Square
      Location ID + Access Token.
- [ ] First sync returns a non-zero catalog + order count.
- [ ] Dashboard shows revenue, orders, and items; "Last synced" shows a recent time.
- [ ] Owner enters item **costs** (Dashboard menu table) so Margins populates.
- [ ] (Optional) Connect DoorDash to unlock Channel Margins.
- [ ] Walk the owner through the revenue methodology note so the POS-vs-app
      difference is understood up front (this is the #1 trust risk — get ahead of it).

---

## 6. Rollback plan

Per [`deployment.md`](deployment.md):

- [ ] **Frontend:** Vercel → redeploy the previous deployment (instant).
- [ ] **Backend:** Railway → roll back to the previous deployment.
- [ ] **Database:** forward-only migrations — roll back by restoring from backup
      (§4) or PITR; do **not** hand-edit. Practice this in the restore drill.
- [ ] Keep the previous known-good commit SHA noted before each deploy.

---

## 7. Feedback collection process

Goal: capture what owners actually experience, structured enough to act on.

- [ ] **Per-restaurant feedback log** — one shared doc (or Notion page) per pilot
      restaurant with a running, dated list: `date · surface · what happened ·
      expected · severity (blocker / friction / nice-to-have)`.
- [ ] **Weekly 15-minute check-in** with each owner for the first 3 weeks. Three
      standing questions:
      1. Did the numbers match what you see in Square / your books? (trust)
      2. What did you look at, and what did you do because of it? (value)
      3. What confused you or felt missing? (clarity)
- [ ] **In-product issues** → triage into the same buckets and file against the
      backlog. Anything tagged *blocker* or *trust* jumps the queue.
- [ ] **Trust ledger:** explicitly track every instance where a displayed number
      didn't match the owner's POS/books, with the cause. This is the dataset that
      decides whether revenue reconciliation (currently a known limitation) becomes
      the next priority.

---

## 8. Definition of "pilot ready"

- [ ] Sections 0–4 complete.
- [ ] One restaurant fully onboarded end-to-end on production (§5) with numbers the
      owner agrees are reasonable.
- [ ] Feedback process (§7) set up and the first check-in scheduled.
- [ ] `known-limitations.md` reviewed with each owner so expectations are set.
