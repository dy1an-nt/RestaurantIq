# Known Limitations

> Honest, current as of Sprint S (pilot readiness). This is the list to set
> expectations with pilot restaurants and to hand any new engineer so nothing
> here is a surprise. Each item links to where it's tracked.

## Data & trust

- **Revenue is menu-item sales, not POS gross.** "Revenue" and "30-Day Revenue"
  are the sum of line items (quantity × item price). Your Square gross total can
  also include tax, tips, discounts, and service fees, so the two **will not
  match exactly**. This is labeled in-product (dashboard note + per-metric
  tooltips) but **not reconciled**. *(Review section 3 #1; Sprint R chose labeling over
  a data-model change.)*
- **Fixed 30-day analysis window.** Every analytics surface uses a trailing
  30-day window. Data older than that isn't shown, and there's no date picker.
  A "Last synced" indicator + stale-data warning surface when data is old.
- **Aggregation is computed app-side.** Fine for a pilot-scale restaurant
  (thousands of orders/month); a very high-volume location (tens of thousands/
  month) would pull a lot of rows to aggregate. *(Review M1.)*
- **Ingestion is not transactional.** A crash mid-sync could in principle leave
  partially-written data for that sync. Re-running the sync is idempotent and
  self-heals. *(Review H3.)*

## Scope

- **One location per account.** No multi-location support.
- **Square (POS) + DoorDash (delivery) only.** No other POS or delivery
  integrations.
- **Manual credential entry.** Onboarding takes a Square Location ID + Access
  Token directly (no hosted OAuth redirect flow yet). Tokens are AES-256-GCM
  encrypted at rest.
- **No data export** (CSV/PDF) and **no drill-down** from a summary number to the
  underlying orders yet.

## Operations & platform

- **Rate limiting is in-memory (per backend instance).** With multiple backend
  replicas a user could get up to N× the intended limit. Pin to a single backend
  instance for the pilot, or accept the looser limit. *(Review M4.)*
- ~~**`TOKEN_ENCRYPTION_KEY` is not fail-fast validated at boot.**~~ *Resolved
  2026-07-09:* the startup env schema now rejects a malformed key anywhere and
  requires `TOKEN_ENCRYPTION_KEY` (or `ACTIVE_TOKEN_ENCRYPTION_KEY`) in
  production, so a misconfigured deploy fails at boot instead of on the first
  token operation. *(Review M7.)*
- ~~**No integrated error tracking / uptime monitoring / alerting.**~~ *Resolved
  2026-08-26:* Sentry reports 5xx responses, uncaught exceptions, and unhandled
  rejections (events scrubbed of tokens/JWTs/keys before sending), and a GitHub
  Actions workflow probes `/health` every ~5 min, opening an issue after three
  consecutive failures. **Both are inert until configured** - Sentry needs
  `SENTRY_DSN`, the uptime check needs a `HEALTH_URL` repository variable. Until
  those are set, monitoring is still manual. Setup: `deployment.md` -> Monitoring.
- **Uptime resolution is coarse.** GitHub's scheduled runs are best-effort and
  can be delayed several minutes, so the uptime check is a safety net, not a
  tight-SLA monitor. An external monitor (UptimeRobot / Better Stack) is the
  higher-resolution option if the pilot needs faster alerting.
- **Developer tools gate is client-side.** Sync Health is hidden behind a
  localStorage dev-mode flag (Settings -> Developer), not a server-side role. It's
  a UX guard to keep an engineering page out of an owner's way, not a security
  boundary - the route still loads if reached directly.

## Testing

- **No automated frontend tests yet.** CI gates frontend typecheck, lint, and
  build, but not runtime behavior. Backend unit, integration, HTTP route,
  scheduler, ingestion, encryption, and tenant-isolation tests are CI-gated.
  Exact totals are omitted because the suite changes frequently.

## AI features

- Chat is capped per day and to an 8-turn context window; insights return 3-6
  items. These are deliberate cost/quality controls, not bugs.
