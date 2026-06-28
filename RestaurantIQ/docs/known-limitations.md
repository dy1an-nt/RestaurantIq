# Known Limitations

> Honest, current as of Sprint S (pilot readiness). This is the list to set
> expectations with pilot restaurants and to hand any new engineer so nothing
> here is a surprise. Each item links to where it's tracked.

## Data & trust

- **Revenue is menu-item sales, not POS gross.** "Revenue" and "30-Day Revenue"
  are the sum of line items (quantity × item price). Your Square gross total can
  also include tax, tips, discounts, and service fees, so the two **will not
  match exactly**. This is labeled in-product (dashboard note + per-metric
  tooltips) but **not reconciled**. *(Review §3 #1; Sprint R chose labeling over
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
- **`TOKEN_ENCRYPTION_KEY` is not fail-fast validated at boot.** It's required to
  store/read integration tokens but isn't in the startup env schema, so a
  misconfiguration boots fine and fails on the first token operation. Double-check
  it's set before the pilot. *(Review M7.)*
- **No integrated error tracking / uptime monitoring / alerting** (e.g. Sentry,
  uptime pings). Monitoring during the pilot is manual — see the pilot checklist.
- **Developer tools gate is client-side.** Sync Health is hidden behind a
  localStorage dev-mode flag (Settings → Developer), not a server-side role. It's
  a UX guard to keep an engineering page out of an owner's way, not a security
  boundary — the route still loads if reached directly.

## Testing

- **No automated frontend tests yet.** CI gates frontend typecheck, lint, and
  build, but not runtime behavior. Backend has ~72% line coverage with 167 tests,
  CI-gated. *(Review R15.)*

## AI features

- Chat is capped per day and to an 8-turn context window; insights return 5–8
  items. These are deliberate cost/quality controls, not bugs.
