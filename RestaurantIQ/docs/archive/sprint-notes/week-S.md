# Sprint S — Pilot Readiness

> **Theme:** No major new features. Make RestaurantIQ easier to understand, trust,
> and adopt so it's ready for a 2–3 restaurant pilot. Every change improves
> usability, trust, clarity, accessibility, or focus.

This sprint acts on the engineering review's product findings (§5, R14): an
owner-facing nav cluttered with engineering tools and three overlapping margin
surfaces, incomplete empty states, and numbers that don't explain themselves.

---

## 1. Product Review

### Pages removed / consolidated
- **Channel Margins → a tab.** "Margins" and "Channel Margins" were two separate
  nav destinations whose distinction an owner wouldn't grasp. They're now two
  tabs ("Item Margins" / "Channel Margins") under one **Margins** page. Each tab
  reuses its original component unchanged via an `embedded` prop that drops the
  component's own title in favor of the shell's. `/channel-margins` redirects to
  `/margins`.
- **Sync Health → developer mode.** The distributed-scheduler observability page
  (engineer-facing) is removed from the owner nav and revealed only when
  *Settings → Developer → Show developer tools* is on (a localStorage flag, no
  backend change). The route still loads directly; it's a UX guard, not a security
  boundary.
- **Settings page added** (reached from the sidebar account card and the topbar
  avatar — deliberately *not* a top-level nav item). Shows account + restaurant
  info, links to Integrations, and hosts the developer toggle. Covers the "settings"
  surface the pilot QA list expects.

### Navigation improvements
- Flat 10-item list → **grouped sections** (Overview · Tools · Setup, plus a
  conditional Developer group).
- The two confusing "Advisor" items renamed: **RIQ Advisor → AI Assistant**,
  **Purchasing Advisor → Forecast** (topbar shows "Demand Forecast").
- Topbar cleaned up: fixed the breadcrumb map (it previously fell back to
  "Dashboard" for `/ai`, `/advisor`, `/settings`), **removed a non-functional
  search box** and a **chevron that implied a date picker that doesn't exist** —
  both were "looks interactive, does nothing" liabilities for a pilot.

### Onboarding improvements
- Brand-token restyle (was off-brand gray/white).
- A welcoming intro that sets the expectation ("connect Square once… about two
  minutes… change anything later").
- A **"Where do I find these?"** help callout for the Square Location ID + Access
  Token (the biggest onboarding unknown), plus per-field hints and a note that the
  token is encrypted and never shown again. "Sandbox Access Token" → "Access Token"
  for real-restaurant language. The existing 3-step progress stepper and "skip"
  escape hatches were kept (already minimal).

### Trust improvements
- **Accessible info tooltips** (`InfoTooltip`) explaining where each number comes
  from: all four dashboard KPIs, the three Analytics chart sections (making the
  line-item-revenue vs. order-total distinction explicit), and the forecast
  **Confidence** column.
- **Forecast confidence** is now explained, not just shown.
- "Last synced" freshness chip (from Sprint R) extended to the **Margins** page;
  stale-data warning continues to replace silent empties.

### Accessibility improvements
- **Skip-to-content** link; `<nav aria-label>` and a focusable `<main id>`
  landmark.
- Tooltips work for keyboard + screen-reader users (focus opens, Escape closes,
  `aria-describedby` ties bubble to trigger) — not hover-only.
- Tabs use `role="tablist/tab/tabpanel"` with `aria-selected`; the dev toggle is a
  proper `role="switch"` with `aria-checked`.
- `aria-label`s on icon-only controls (alerts bell incl. unread count, avatar →
  settings, account card, sign out, unread badge).
- `focus-visible` rings on nav links, tabs, buttons, and the avatar — keyboard
  focus is now visible app-wide.

---

## 2. UX Metrics (before → after)

| Metric | Before | After |
|---|---|---|
| Owner-facing nav destinations | **10** (flat) | **8**, grouped into 3 sections (Channel Margins merged; Sync Health dev-gated) |
| Engineering pages in owner nav | 1 (Sync Health) | **0** (behind dev mode) |
| Overlapping margin surfaces | 3 (Margins, Channel Margins, Analytics) | **1 Margins page** (2 tabs) + Analytics |
| Onboarding steps | 3 | 3 (already minimal) — now with credential help + clearer first-run |
| Reusable trust/empty components | 0 | **2** (`InfoTooltip`, `EmptyState`) + dev-mode + Settings |
| Calculations with an in-product explanation | revenue note only (Sprint R) | **8 metrics** (4 KPIs + 3 charts + forecast confidence) |
| Accessibility: skip link / landmarks / focus-visible | none | **added** app-wide |
| Non-functional UI controls (search box, fake dropdown) | 2 | **0** (removed) |
| Duplicated empty-state blocks | 2 bespoke | **1 shared `EmptyState`** |

---

## 3. Manual QA — major workflows

Run on the pilot/sandbox environment after deploy. All should pass; none should regress.

- [ ] **Sign up** — new account; redirected into onboarding.
- [ ] **Login / logout** — session persists; logout returns to landing; protected
      routes redirect when logged out.
- [ ] **Connect restaurant** — onboarding step 1 creates the restaurant; the
      credential help callout renders; step 2 connects Square.
- [ ] **Sync data** — onboarding "Run sync" (and topbar "Run sync") pull catalog +
      orders; success count shown.
- [ ] **Analytics** — dashboard KPIs + tooltips render; Analytics charts + section
      tooltips render; "Last synced" chip shows; revenue methodology note present.
- [ ] **Margins** — `/margins` shows tabs; Item Margins and Channel Margins each
      load, including empty states (`EmptyState`); `/channel-margins` redirects.
- [ ] **Forecasting** — Forecast page loads; confidence column + its tooltip work.
- [ ] **AI assistant** — `/ai` loads and responds; daily cap respected.
- [ ] **Settings** — reachable from account card + avatar; account/restaurant info
      correct; developer toggle reveals/hides Sync Health in the nav (and persists
      across reload).
- [ ] **Onboarding** — full first-run flow; skip paths work.
- [ ] **Accessibility spot-check** — Tab from page top hits "Skip to content";
      focus rings visible; tooltips open on focus and close on Escape; nav operable
      by keyboard.

---

## 4. Pilot readiness

Deliverables for running the pilot live in:
- [`pilot-checklist.md`](../../pilot-checklist.md) — go/no-go gates, env config,
  migrations, monitoring, backup/restore drill, rollback, per-restaurant
  onboarding, and the **feedback collection process**.
- [`known-limitations.md`](../../known-limitations.md) — honest current limitations to
  set expectations with pilot owners.
- Deployment + env reference verified against [`deployment.md`](../../deployment.md)
  and [`operations.md`](../../operations.md) (both current; not duplicated).

---

## 5. Files changed

### New (frontend)
- `pages/Margins.tsx` — tabbed shell consolidating the two margin pages.
- `pages/Settings.tsx` — account/restaurant hub + developer toggle.
- `components/InfoTooltip.tsx` — accessible explanation tooltip.
- `components/EmptyState.tsx` — standardized empty state.
- `lib/useDevMode.ts` — localStorage dev-mode flag (reactive across the app + tabs).

### New (docs)
- `docs/pilot-checklist.md`, `docs/known-limitations.md`, and this archived sprint note.

### Modified (frontend)
- `App.tsx` — Margins/Settings routes, channel-margins redirect, skip link + main landmark.
- `components/Sidebar.tsx` — grouped sections, renames, dev-gated Sync Health, account card → Settings, a11y.
- `components/Topbar.tsx` — breadcrumb map fix, removed dead search + chevron, avatar → Settings, a11y.
- `components/DashboardKpis.tsx` — KPI tooltips.
- `components/advisor/ForecastTable.tsx` — confidence tooltip.
- `pages/Analytics.tsx` — chart-section tooltips.
- `pages/MarginAnalysis.tsx`, `pages/ChannelMargins.tsx` — `embedded` prop, `EmptyState`, brand-token restyle (MarginAnalysis).
- `pages/Onboarding.tsx` — brand restyle, credential help, welcome intro.

---

## 6. Definition of Done

| Criterion | Status |
|---|---|
| Navigation simplified | ✅ 10 → 8 grouped; 2 surfaces consolidated/removed |
| Engineering-only pages hidden from normal users | ✅ Sync Health behind dev mode |
| Every major metric explains itself | ✅ 8 metrics with tooltips + methodology notes |
| Onboarding polished | ✅ welcome, credential help, brand restyle |
| Accessibility issues addressed | ✅ skip link, landmarks, focus-visible, ARIA tooltips/tabs/switch |
| Product feels cohesive | ✅ MarginAnalysis restyled to brand; shared empty/tooltip components |
| Ready for a 2–3 restaurant pilot | ✅ pilot-checklist.md + known-limitations.md + feedback process |
| No functionality regressed | ✅ frontend typecheck/lint/build green; backend untouched + still green |
