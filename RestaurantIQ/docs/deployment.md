# Deployment Guide

RestaurantIQ deploys as two independently-hosted services:

| Service  | Folder                  | Host (recommended) | Build         | Start            |
| -------- | ----------------------- | ------------------ | ------------- | ---------------- |
| Frontend | `restaurantiq-frontend` | Vercel             | `npm run build` | static (`dist/`) |
| Backend  | `restaurantiq-backend`  | Render             | `npm ci --include=dev && npm run build` | `npm start`      |

Because the two run on different origins in production, the backend enforces a
CORS allowlist and the frontend talks to the backend through a single
configurable base URL. Everything below is about wiring those two pieces
together safely.

---

## Architecture at a glance

```
Browser ──HTTPS──▶  Frontend (Vercel, static)
   │
   └──fetch(VITE_API_URL)──▶  Backend (Render, Express)   ──▶  Supabase (Postgres + Auth)
                                                          └──▶  Anthropic API
```

- The frontend bundles `VITE_API_URL` at **build time** and sends every API
  request there via the shared client in
  [`src/lib/api.ts`](../restaurantiq-frontend/src/lib/api.ts).
- The backend validates its environment at **startup** and refuses to boot if a
  required variable is missing (see
  [`src/config/env.ts`](../restaurantiq-backend/src/config/env.ts)).
- The backend only accepts browser requests from origins in `FRONTEND_URL`
  (see [`src/config/cors.ts`](../restaurantiq-backend/src/config/cors.ts)).

---

## Frontend environment variables

Set these in Vercel -> Project -> Settings -> Environment Variables. They are
**public** (shipped to the browser), so never put secrets here.

```env
# Base URL of the deployed backend. No trailing slash.
VITE_API_URL=https://restaurantiq-backend.onrender.com

# Supabase project URL and PUBLIC anon key.
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

> Vite only exposes variables prefixed with `VITE_`, and it inlines them at
> build time. If you change `VITE_API_URL`, you must **redeploy** the frontend -
> there is no runtime override.

Template: [`restaurantiq-frontend/.env.example`](../restaurantiq-frontend/.env.example)

---

## Backend environment variables

Declared in [`render.yaml`](../../render.yaml) at the repo root. Render prompts
for every `sync: false` value once, during blueprint creation, and never again.
Anything added later goes in Render -> Service -> Environment.

### Required (server refuses to start without these)

```env
SUPABASE_URL=https://YOUR-PROJECT.supabase.co        # also drives JWT verification (JWKS)
SUPABASE_SERVICE_ROLE_KEY=eyJ...                      # service_role secret - server only
ANTHROPIC_API_KEY=sk-ant-...                          # AI insights + marketing copy
```

### Strongly recommended in production

```env
NODE_ENV=production                                   # locks CORS to FRONTEND_URL (drops localhost)
FRONTEND_URL=https://restaurantiq.vercel.app          # comma-separate multiple origins
DATABASE_URL=postgresql://USER:PASS@HOST:5432/postgres # direct/session pooler (port 5432) for the sync scheduler's advisory-lock leader election
```

### Optional

```env
PORT=3001                                             # Render injects its own PORT; this is the fallback
ANTHROPIC_MODEL=claude-haiku-4-5-20251001             # override default model
SUPABASE_JWT_SECRET=...                               # only needed for HS256 fallback (unused when SUPABASE_URL is set)
SYNC_SCHEDULER_ENABLED=true                           # set false to disable background syncs
SYNC_INTERVAL_MINUTES=15
INSTANCE_ID=render-1                                  # label for leader-election logs

# Integrations (needed only when connecting real Square / DoorDash accounts)
SQUARE_ENVIRONMENT=production
SQUARE_ACCESS_TOKEN=...
SQUARE_APPLICATION_ID=...
SQUARE_APPLICATION_SECRET=...
DOORDASH_CLIENT_ID=...
DOORDASH_CLIENT_SECRET=...

# Token encryption at rest. REQUIRED with NODE_ENV=production - boot fails
# without ACTIVE_TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY, and a malformed
# key (not 64 hex chars) fails boot in any environment.
ACTIVE_TOKEN_ENCRYPTION_KEY=<64 hex chars>            # openssl rand -hex 32
LEGACY_TOKEN_ENCRYPTION_KEYS=

# Rate limiting (Claude-powered endpoints /api/insights + /api/marketing).
# Per-user window + request cap; defaults shown. Protects against Anthropic cost abuse.
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=50

# Health-check version string (optional; defaults to package.json version)
APP_VERSION=1.0.0

# Error tracking (optional; leave SENTRY_DSN unset to disable Sentry)
SENTRY_DSN=https://public@example.ingest.sentry.io/project
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0
```

### Production hardening behavior (Sprint N)

With `NODE_ENV=production` the backend automatically:
- sets security headers via **helmet** (HSTS, `nosniff`, `X-Frame-Options`, a
  cross-origin resource policy compatible with the Vercel SPA + Supabase),
- **rate-limits** the Claude endpoints per authenticated user (returns `429` with
  the standard `{ data: null, error }` envelope when exceeded),
- emits **structured JSON request logs** (method, route, status, response time;
  never tokens/secrets) and JSON error logs to stderr,
- **hides internal error messages and stack traces** from API responses - 5xx
  responses return a generic message while the full error is logged server-side.

All errors across the API share one shape: `{ "data": null, "error": "message" }`.

### Monitoring

Two independent pieces, both optional and both inert until configured.

**Error tracking (Sentry).** Set `SENTRY_DSN` and the backend reports 5xx
responses plus any uncaught exception / unhandled rejection. Leave it unset and
the integration never initializes. No SDK init, no network calls. 4xx are
deliberately not reported: a client sending a bad request is not an incident.
Startup logs one line, `{"event":"SENTRY_STATUS","enabled":true|false}`, so you
can confirm which mode a deploy is in.

Events are scrubbed before they leave the process (`src/config/sentryScrub.ts`):
the request body is dropped outright, headers are reduced to an allowlist, and
the whole event is pattern-scrubbed for Square tokens, Supabase JWTs, Anthropic
keys, and 64-hex encryption keys. This matters because onboarding posts a Square
access token in a request body, and Sentry's own defaults would capture it.

**Uptime (GitHub Actions).** `.github/workflows/uptime.yml` probes `/health`
every ~5 minutes and opens (or comments on) a GitHub issue labelled `uptime`
after three consecutive failures. One-time setup:

> Settings → Secrets and variables → Actions → Variables → New repository
> variable → `HEALTH_URL` = `https://<backend>.onrender.com/health`

Without that variable every run skips. GitHub's scheduled runs are best-effort
and can be delayed several minutes under load, so this is a safety net rather
than a tight-SLA monitor; an external monitor (UptimeRobot, Better Stack) gives
1-minute resolution and real alerting if the pilot needs it.

Full template with inline notes:
[`restaurantiq-backend/.env.example`](../restaurantiq-backend/.env.example)

> **A note on `JWT_SECRET`:** this project does **not** use a separate app-level
> JWT secret. Supabase issues and signs the access tokens; the backend verifies
> them against Supabase's JWKS endpoint, which only needs `SUPABASE_URL`.
> `SUPABASE_JWT_SECRET` exists solely as an HS256 fallback and is optional.

### What happens when a required variable is missing

The process exits immediately with a readable message instead of failing later
with an opaque `undefined`:

```txt
Missing or invalid environment variables:
  - ANTHROPIC_API_KEY: Required

See docs/deployment.md for the full list of required variables.
```

---

## Local setup

1. **Backend**

   ```bash
   cd restaurantiq-backend
   cp .env.example .env          # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
   npm install
   npm run dev                   # http://localhost:3001
   ```

   Keep `NODE_ENV` unset (or `development`) locally so CORS automatically allows
   `http://localhost:5173`.

2. **Frontend**

   ```bash
   cd restaurantiq-frontend
   cp .env.example .env          # VITE_API_URL=http://localhost:3001 + Supabase anon vars
   npm install
   npm run dev                   # http://localhost:5173
   ```

The frontend talks to `http://localhost:3001` directly (no dev proxy), so local
development exercises the same cross-origin path as production.

---

## Render deployment (backend)

The service is defined as a blueprint in [`render.yaml`](../../render.yaml) at
the repo root, so most of this is one dashboard flow rather than a field-by-field
setup. Read that file alongside these steps; its comments carry the reasoning.

1. **Render Dashboard -> New -> Blueprint**, pointed at this repository. Render
   reads `render.yaml` and creates the `restaurantiq-backend` web service with
   `rootDir` already set to `RestaurantIQ/restaurantiq-backend`.
2. Render prompts for every `sync: false` variable during that first creation
   flow and never again. Have these ready: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TOKEN_ENCRYPTION_KEY`
   (64 hex chars, `openssl rand -hex 32`), `FRONTEND_URL`, and `DATABASE_URL`.
   Anything you add later goes in Service -> Environment.
3. The build command is `npm ci --include=dev && npm run build`. The
   `--include=dev` is required, not cosmetic: the blueprint sets
   `NODE_ENV=production`, Render applies env vars during the build, and npm then
   omits devDependencies. `typescript` is one of them, so a plain `npm ci`
   leaves no `tsc` and the build dies with `tsc: not found`.
4. Node version comes from the `NODE_VERSION=22` env var in the blueprint, which
   matches the `engines` pin in both `package.json` files and what CI runs.
5. Deploy. Render injects `PORT` itself and `src/server.ts` reads it. Do not set
   `PORT` in the blueprint.
6. **Run database migrations** before/at first deploy so the schema matches the
   code. From a machine with the production `DATABASE_URL` (see
   [migrations.md](./migrations.md)):
   ```bash
   cd restaurantiq-backend
   DATABASE_URL=<prod> npm run migrate:baseline   # FIRST TIME ONLY - adopt existing DB
   DATABASE_URL=<prod> npm run migrate            # apply any pending migrations
   DATABASE_URL=<prod> npm run migrate:status     # expect: 0 pending
   ```
7. Copy the public URL (e.g. `https://restaurantiq-backend.onrender.com`) -
   you'll need it for the frontend's `VITE_API_URL`.
8. **Startup verification:** check the Render deploy logs for
   `RestaurantIQ API running on port ...`. A missing/invalid env var instead
   prints `Missing or invalid environment variables:` and the process exits -
   fix the variable and redeploy.
9. **Health check:** `curl https://<your-backend>/health` ->
   `{"status":"ok","timestamp":"...","version":"..."}`. The blueprint already
   sets `healthCheckPath: /health`, which Render also uses to decide a deploy is
   live. The endpoint needs no auth and touches no database.
10. Check the service's **Auto-Deploy** setting so you know whether a push to
    `main` ships immediately. Nothing in the blueprint gates a deploy on CI, so
    if you want that gate, use branch protection on `main` with the CI checks
    marked required.

> **The free plan spins down.** A free web service sleeps after 15 minutes with
> no requests and takes about a minute to wake. The sync scheduler does not run
> while asleep, so the `HEALTH_URL` uptime probe below is what keeps background
> syncs firing. Setting it is functional here, not just monitoring. The plan
> allows 750 instance hours per workspace per month; kept awake continuously
> this service uses roughly 730, which fits with no room for a second service.

> For `DATABASE_URL`, use Supabase's **session pooler / direct connection on
> port 5432**, not the transaction pooler (6543) - the scheduler's
> `pg_try_advisory_lock` leader election needs a session-level connection.

---

## Vercel deployment (frontend)

1. **New Project -> Import the GitHub repo**, then set the **Root Directory** to
   `restaurantiq-frontend`.
2. Framework preset: **Vite**. Confirm:
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Build verification: `npm run build` should complete with a `dist/` bundle
     (a chunk-size advisory is expected and non-fatal). Run it locally first if
     unsure - a failing build fails the Vercel deploy.
3. Add environment variables: `VITE_API_URL` (the Render URL from above),
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Note the resulting domain (e.g. `https://restaurantiq.vercel.app`).
5. Go back to Render and make sure that domain is in `FRONTEND_URL`, then
   redeploy the backend if you changed it.

> Vercel preview deployments get unique URLs. To allow them, either add the
> specific preview URL to `FRONTEND_URL` (comma-separated) or test previews
> against a backend whose `NODE_ENV` is not `production`.

> Vercel reads the Node version from `engines` in `package.json` (pinned
> `>=22`). Vercel production deploys are only gated on CI if `main` has GitHub
> branch protection with the CI checks marked required.

---

## Pre-deploy configuration checklist

- [ ] Backend `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` set.
- [ ] Backend `NODE_ENV=production`.
- [ ] Backend `FRONTEND_URL` exactly matches the deployed frontend origin
      (scheme + host, no trailing slash).
- [ ] Backend `DATABASE_URL` points at the session pooler / direct conn (port 5432).
- [ ] Token encryption key set (`ACTIVE_TOKEN_ENCRYPTION_KEY`) if using integrations.
- [ ] Rate-limit vars reviewed (`RATE_LIMIT_WINDOW_MINUTES`, `RATE_LIMIT_MAX_REQUESTS`).
- [ ] Production secrets stored in the team password manager (see
      [operations.md](./operations.md#environment-variable-recovery)).
- [ ] Migrations applied + `npm run migrate:status` shows `0 pending`
      (see [migrations.md](./migrations.md)).
- [ ] Frontend `VITE_API_URL` points at the Render backend (no trailing slash).
- [ ] Frontend redeployed after any `VITE_API_URL` change.

## Post-deployment checklist

Run these against the live deployment after every production deploy:

- [ ] **Health endpoint** - `curl https://<backend>/health` returns 200 with
      `{"status":"ok","timestamp":"...","version":"..."}`.
- [ ] **Authentication** - logging into the deployed frontend succeeds and a
      protected request (e.g. dashboard data) returns 200 with a valid session;
      an unauthenticated request returns 401.
- [ ] **Dashboard loads** - analytics/dashboard renders data with no errors in
      the browser console.
- [ ] **Square sync works** - trigger or wait for a sync; integration status
      shows success and order/summary data updates (Sync Health page).
- [ ] **AI insights work** - the insights endpoint returns a result (proves
      `ANTHROPIC_API_KEY` and outbound access to Anthropic).
- [ ] **Rate limiting works** - exceeding `RATE_LIMIT_MAX_REQUESTS` on
      `/api/insights` returns `429` with `{ "data": null, "error": ... }`.
- [ ] **Security headers present** -
      `curl -sI https://<backend>/health | grep -i -E 'strict-transport|x-frame|x-content-type'`
      shows helmet headers.
- [ ] **CORS** - the deployed frontend loads with no CORS errors, and a request
      from an unlisted origin is blocked (no `Access-Control-Allow-Origin` header).
- [ ] **Cross-origin requests succeed** - the SPA on Vercel can call the Render
      backend (the end-to-end path of the two checks above).

## Related operational docs

- [operations.md](./operations.md) - backups, recovery, disaster recovery.
- [migrations.md](./migrations.md) - schema migration workflow and rollback.
```
