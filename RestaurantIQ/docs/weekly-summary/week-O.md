# Week O — Branding, Design System & UX Polish (the app finally looks like a product)

> For fourteen sprints RestaurantIQ has been growing real machinery — ingestion, token refresh, schedulers, rate limits — behind a UI assembled from default Tailwind grays and emoji. Sprint O is the first sprint that touches **only** the frontend, and it does the unglamorous work that turns "a working demo" into "a thing you'd show a restaurant owner": a single source-of-truth color/type system, an emoji-free icon set, a public marketing landing page, a split-screen auth experience, and a top bar that orients you in the app. No new endpoints, no schema changes. Every byte of this sprint is presentation — but presentation built like infrastructure, with the design decisions centralized in `tailwind.config.js` instead of sprinkled across 20 files.

---

## Sprint goal in one sentence
Give RestaurantIQ a coherent visual identity — one navy-anchored design system defined in Tailwind theme tokens, a hand-drawn SVG icon set replacing every emoji, a real public landing page, a branded split-screen auth flow, and a dashboard chrome (sidebar + topbar + KPI strip) that reads as a finished product — **without touching the backend or changing a single API contract.**

## What shipped, in plain English
- The whole app got a consistent look: one navy brand color, a real typeface (Hanken Grotesk), calm muted "good/bad/warning" colors, and proper spacing — all defined in one config file so a color change is one edit, not fifty.
- Every emoji in the UI (📊 🤖 🔔 …) was replaced with a clean, custom-drawn outline icon set that scales crisply and matches the brand.
- There's now an actual public **landing page** — hero, feature cards, "how it works," a live-looking analytics showcase, and calls to action — for someone who isn't logged in yet.
- The login and signup screens were rebuilt as a polished split-screen: a navy marketing panel with a testimonial on one side, the form on the other, with tabs to switch between sign in and create account.
- The signed-in app gained a **top bar** (breadcrumb, search, date range, "Run sync" button, alerts bell, avatar) and a redesigned sidebar, plus a four-stat **KPI strip** on the dashboard.
- A small shared hook now powers the "unread alerts" badge that appears in both the sidebar and the topbar bell — fetched once, failing silently because it's peripheral UI.

---

## File-by-file (every file touched, what it is + why it exists)

### The design system (the foundation everything else stands on)

- **`restaurantiq-frontend/tailwind.config.js`** (modified) — The single source of truth for the brand. Defines the `navy` palette (50→900, with `700 = #1e3a5f` flagged as the primary brand), a three-step `ink` text ramp (primary/secondary/muted), two `line` border weights, `surface`/`canvas` backgrounds, and the muted data colors `pos`/`neg`/`warn` (each with a matching `-bg` tint). Also sets the `Hanken Grotesk` font stack, custom border radii (cards default to 10px), three named shadows (including `shot` for the landing hero's product mock), and two tight letter-spacing values for headlines. **This file is the sprint.** Every component below references these tokens (`text-ink-2`, `bg-navy-700`, `border-line`) instead of hardcoding hex — so the brand is themeable from one place.
- **`restaurantiq-frontend/src/index.css`** (modified) — The few things Tailwind utilities can't express cleanly: sets the body font/color/background, enables font smoothing and `font-feature-settings` (stylistic sets `ss01`/`cv01` for the typeface), a hair of negative tracking on body text, and the `.tnum` utility (`font-variant-numeric: tabular-nums`) used on every number in tables and KPIs so digits line up in columns and don't jitter when values change. Note: per the "Tailwind only, no custom CSS" convention, this stays minimal — `.tnum` is the one genuinely-needed custom class.
- **`restaurantiq-frontend/index.html`** (modified) — Adds the Google Fonts `<link>` for Hanken Grotesk (with `preconnect` hints to shave the round-trip) and sets the `<title>`. Small file, but it's why the typeface loads at all.

### New brand primitives

- **`restaurantiq-frontend/src/components/Logo.tsx`** (new) — A self-contained SVG monogram ("R" on a rounded navy plate) rendered at any `size`, with an `on="navy" | "light"` prop so the same mark works on a light surface (navy plate) and on the dark brand panel (translucent plate). The header comment is explicit that this is a **placeholder** until a real logo is delivered — and the whole point of wrapping it in a component is that swapping the SVG later is a one-file change; the rest of the app just renders `<Logo />`.
- **`restaurantiq-frontend/src/components/Icons.tsx`** (new) — The icon system. One `Icon` component takes a `name` (typed as the `IconName` union) and renders a 24×24 outline SVG that inherits `currentColor` and stroke width from props. The `PATHS` record holds ~25 hand-authored path sets (dashboard, analytics, margins, insights, alerts, marketing, integrations, sync, arrows, etc.). The header comment ships the **old-emoji → new-icon mapping**, which is the migration's Rosetta stone. Centralizing icons here means consistent stroke weight and sizing everywhere, and `text-*` color classes "just work" because the SVG strokes with `currentColor`.

### The public marketing surface

- **`restaurantiq-frontend/src/pages/Landing.tsx`** (new) — The unauthenticated landing page, composed of small local section components (`TopNav`, `Hero`, `ProofBar`, `Features`, `HowItWorks`, `AnalyticsShowcase`, `FinalCTA`, `Footer`). The clever bit: the "Analytics" showcase renders the **real** `RevenueTrendChart`, `TopItemsChart`, and `SalesHeatmap` components — fed by local `SAMPLE_*` constants whose shapes mirror the production API exactly (`revenue_cents`, `{ day, hour, orders }`, etc.). So the marketing page can't drift from how the product actually renders, and the sample money is in cents like everywhere else. The header comment is honest that this is illustrative data, not a signed-in view.

### Branded auth

- **`restaurantiq-frontend/src/components/auth/AuthShell.tsx`** (new) — The split-screen auth layout: a navy marketing panel (headline, three stat figures, a testimonial, decorative concentric circles) on the left, and a centered form column on the right with a segmented tab control whose two tabs are real `<Link>`s to `/login` and `/signup`. Takes a `mode` prop to highlight the active tab and renders the page's form as `children`. This is the **composition seam** that let Login and Signup shed all their layout code.
- **`restaurantiq-frontend/src/pages/Login.tsx`** & **`Signup.tsx`** (modified) — Rebuilt to wrap their forms in `<AuthShell mode=…>` instead of carrying their own page chrome. The form logic (the actual `signIn`/`signUp` calls, error state, navigation) is unchanged — only the presentation moved. Both now use the shared `inputWrap`/`inputField` class strings and `Icon`-prefixed fields (mail/lock), and the focus ring is the navy token. **No auth behavior changed**, which is exactly what you want from a redesign sprint.

### Signed-in app chrome

- **`restaurantiq-frontend/src/App.tsx`** (modified) — Adds the `Landing` route (mounted at `/welcome`) and `ProtectedRoute` import, and introduces an `AppLayout` wrapper that composes `Sidebar` + the new `Topbar` + an `<AlertsBanner />` + scrollable `<main>`, then wraps every authenticated page in it. Note one real nuance worth flagging (see Punted): the catch-all and `/` routes still go to the dashboard for unauthenticated users (gated by `ProtectedRoute` → redirect to `/login`); the new public landing lives at `/welcome`, not `/`.
- **`restaurantiq-frontend/src/components/Sidebar.tsx`** (modified) — Restyled onto the new tokens and the `Icon`/`Logo` components. Nav items are data-driven (`navItems` array with typed `IconName`s), the active item gets the navy fill, and the Alerts row shows a live unread badge from `useUnreadAlerts`. The footer card shows restaurant initials + name + a `location · source` meta line and a sign-out button.
- **`restaurantiq-frontend/src/components/Topbar.tsx`** (new) — The app's top chrome. A `ROUTE_META` map turns the current pathname into a breadcrumb + title; there's a (currently local-state-only) menu-item search box, a fixed "Last 30 days" date-range chip, a context-sensitive primary action (**"Run sync"** linking to Integrations on the dashboard, otherwise an alerts **bell** with an unread pip), and an avatar showing initials derived from the user's email. Mirrors the sidebar's use of `useUnreadAlerts`.
- **`restaurantiq-frontend/src/components/DashboardKpis.tsx`** (new) — The four-stat strip above the menu table (30-Day Revenue, Orders, Avg. Order Value, Items Tracked). It derives every value from endpoints the app already calls — `/api/analytics/dashboard` and the menu-items list — summing `revenue_cents` and `orders` client-side. Two decisions are baked into the comments and worth internalizing: (1) it deliberately **does not** show week-over-week deltas because the backend exposes no previous-period comparison, so a "+8.4%" would be fabricated; (2) it's peripheral, so on error it fails quietly (`setKpis([])`) and renders nothing rather than an error box. It also uses `AbortController` + a `cancelled` flag for correct cleanup.
- **`restaurantiq-frontend/src/pages/Dashboard.tsx`** (modified) — Slimmed to a header, `<DashboardKpis />`, and `<MenuItemsTable />`. The subtitle is composed from the restaurant name/location. The page is now mostly layout because the substance moved into reusable components.

### Restyled feature pages & components (presentation-only)

These were re-skinned onto the design tokens and `Icon` set. Their data fetching, money-in-cents handling, and logic are unchanged.

- **`restaurantiq-frontend/src/pages/Analytics.tsx`**, **`MarginAnalysis.tsx`**, **`Marketing.tsx`**, **`Integrations.tsx`**, **`Onboarding.tsx`** (modified) — Re-skinned to the new palette/typography; charts and tables now sit in `bg-surface border-line` cards. (Onboarding's stepper still carries a few legacy `gray-*`/`bg-gray-200` classes — see Punted.)
- **`restaurantiq-frontend/src/components/MenuItemsTable.tsx`** (modified) — Re-skinned; the trend badge and "Add cost" chip now use `Icon` + the `pos`/`neg`/`warn` tokens instead of emoji/ad-hoc colors. Still formats `cents / 100` for display.
- **`restaurantiq-frontend/src/components/EditMenuItemModal.tsx`** (modified) — Re-skinned to the token system; the `MenuItemPatch` shape and `price_cents`/`cost_cents` handling are untouched.
- **`restaurantiq-frontend/src/components/InsightsPanel.tsx`** (modified) — Partially migrated: the layout uses new tokens but the per-category badge styles still use stock Tailwind palettes (`bg-blue-100`, `gray-*` skeletons). Flagged as incomplete in Punted.

### Charts re-themed to the brand

- **`restaurantiq-frontend/src/components/charts/RevenueTrendChart.tsx`** (modified) — Now an `AreaChart` with a navy `linearGradient` fill, hairline horizontal-only grid, axis ticks in muted ink, and a rounded tooltip. Still receives `revenue_cents` and formats to dollars only at the axis/tooltip (e.g. `$12k`, full `$xx.xx` in the tooltip).
- **`restaurantiq-frontend/src/components/charts/TopItemsChart.tsx`** (modified) — Rebuilt from a Recharts bar chart into a **hand-rolled horizontal bar list** (a CSS grid of name / gradient bar / value). Sorts by `revenue_cents`, takes top 6, scales each bar to the max. Numbers use `.tnum`.
- **`restaurantiq-frontend/src/components/charts/SalesHeatmap.tsx`** (modified) — Re-themed to exactly **3 navy shades** (the comment notes 5 "looked jumbled"), bucketed by each cell's share of the busiest hour, with the empty color set to the canvas token. Builds a 7×24 matrix with `useMemo` and shows a hover tooltip with orders + `revenue_cents` formatted to dollars.

### Shared hook

- **`restaurantiq-frontend/src/lib/useUnreadAlerts.ts`** (new) — A tiny hook that fetches `/api/alerts` once per session and returns the count of `!is_read` rows, driving both the sidebar badge and the topbar bell pip. Honors the `{ data, error }` envelope (`body.error` / `body.data` guards), uses `AbortController` + a `cancelled` flag, and **swallows all failures** because a missing alert badge should never break the chrome. One fetch, two consumers — the reason it's a hook and not duplicated logic.

---

## Key technical decisions (context → decision → why → subtle bug)

### Centralize the brand in Tailwind theme tokens, not in components
- **Context.** The old UI hardcoded Tailwind defaults (`text-gray-500`, `bg-blue-600`) across dozens of files. A rebrand under that scheme means find-and-replacing color classes everywhere and hoping you got them all.
- **Decision.** Define every brand value — colors, type, radii, shadows, tracking — in `tailwind.config.js`'s `theme.extend`, and have components reference *semantic* tokens (`ink`, `ink-2`, `line`, `surface`, `pos`, `neg`) rather than raw colors.
- **Why.** Semantic tokens decouple "what this thing means" (muted label text) from "what color it is" (`#76808f`). Change the primary from navy to forest green and it's one edit to `navy.700`. This is the same indirection-buys-flexibility principle the backend uses for config — one source of truth, referenced by name.
- **Subtle issue we hit / left.** The migration isn't 100% complete. `InsightsPanel.tsx` still uses stock `bg-blue-100`/`bg-amber-100` category badges and `gray-*` skeletons, and `Onboarding.tsx`'s stepper has `bg-gray-200`/`text-gray-400`. They render fine but they bypass the token system, so they *won't* follow a future rebrand. Named in Punted.

### A custom SVG icon component instead of an icon library (and instead of emoji)
- **Context.** The UI was full of emoji (📊 🤖 🔔). Emoji render differently per OS/browser, can't inherit text color, and look unprofessional next to a real typeface.
- **Decision.** Hand-author ~25 outline icons in one `Icons.tsx`, exposed via a single `<Icon name=… />` whose SVG strokes with `currentColor`.
- **Why.** No new dependency, every icon shares one stroke weight and 24×24 grid, and `text-navy-700` / `text-pos` color them for free because they inherit `currentColor`. A library (lucide, heroicons) would also work, but for a fixed, small set this keeps the bundle lean and the visual language tightly controlled. The header comment's emoji→icon mapping makes the migration auditable.
- **Tradeoff.** Hand-drawn paths are more upfront effort and you own the rendering bugs. Worth it at this set size; revisit if the set balloons.

### The landing page renders the *real* chart components on sample data
- **Context.** A marketing page needs to *show* the product's charts. The lazy path is screenshots or bespoke mock visuals.
- **Decision.** Import the actual `RevenueTrendChart` / `TopItemsChart` / `SalesHeatmap` and feed them local `SAMPLE_*` constants shaped like the real API (cents, `{day,hour,orders}`).
- **Why.** The landing page can never visually lie about what the product looks like — if the chart changes, the marketing shot changes with it, for free. And keeping the sample money in **cents** respects the project-wide money convention even in fake data, so nobody copy-pastes a float into a real path later.
- **Tradeoff.** The landing page now depends on the chart components staying prop-compatible; a breaking prop change to a chart breaks the landing build. That's a feature (it forces you to notice) more than a bug.

### Extract auth layout into `AuthShell`, leave auth logic alone
- **Context.** Login and Signup needed identical new chrome (split-screen, tabs, brand panel).
- **Decision.** Put all of it in `AuthShell` and have each page pass only its form as `children` plus a `mode`.
- **Why.** DRY for the layout, and — crucially for a redesign sprint — it let the actual authentication code (`signIn`/`signUp`, error handling, redirects) stay byte-for-byte unchanged. The smaller the surface you touch, the smaller the regression risk. A redesign that quietly alters auth behavior is how you ship a login bug.

### KPIs refuse to show deltas the backend can't substantiate
- **Context.** A KPI strip "wants" trend arrows ("+8.4% vs last month") — and the landing/auth mockups even show them.
- **Decision.** `DashboardKpis` shows only absolute values and **no** week-over-week deltas, with a comment saying exactly why.
- **Why.** The backend exposes no previous-period comparison. Rendering a delta would mean fabricating it. The honest call is to show what's true and leave the delta for when the API supports it. This is the same "null isn't zero / don't invent money" discipline the backend applies to costs, applied to the dashboard.

---

## Patterns and concepts you used (mechanics → CS concepts)

- **Design tokens / theming indirection.** Semantic names (`ink-2`, `pos-bg`) map to values in one config; components depend on the name, not the value. This is the design-system version of "program to an interface" — and it's why a rebrand is one diff.
- **`currentColor` as inheritance.** SVG icons stroke with `currentColor`, so they pick up whatever `text-*` color their parent sets. One icon, infinite colorways, no props plumbing.
- **Composition over duplication (`AuthShell`, `AppLayout`).** Shared chrome lives in a wrapper that takes the variable part as `children` — the React expression of "extract the common, parametrize the difference," the same instinct the backend used to share its ingestion write path.
- **Single fetch, multiple consumers (a custom hook).** `useUnreadAlerts` centralizes one fetch + its lifecycle; sidebar and topbar both consume it. State that's needed in two places belongs in one hook, not two effects.
- **Correct async cleanup.** Both new data components use `AbortController` + a `cancelled` flag so a fast route change can't set state on an unmounted component or apply a stale response. (Abort cancels the network; the flag guards the late `.then`.)
- **Fail-soft for peripheral UI.** The alert badge and the KPI strip swallow errors and render nothing on failure. Knowing which UI is load-bearing (the menu table's own empty state) vs. decorative (a badge) is a real design call, mirroring the backend's "fire-and-forget alerts" choice.
- **Tabular figures (`font-variant-numeric: tabular-nums`).** Monospaced digits in proportional type so columns of money align and values don't shift width as they change. A small typographic detail that signals "finance product."
- **Presentational vs. container split.** This sprint mostly moved *presentation* while leaving *behavior* (fetching, money math, auth) untouched — the clearest possible demonstration of why separating the two makes a redesign low-risk.

---

## What you should be able to explain in an interview

**Q: You rebranded an app spread across ~25 files. How did you make that maintainable instead of a find-and-replace nightmare?**
I put the entire brand — colors, type, radii, shadows, tracking — in Tailwind's theme config as semantic tokens, and had components reference the *meaning* (`text-ink-2` for muted text, `bg-pos` for "good") rather than raw hex. So the value lives in exactly one place. Changing the primary brand color is a one-line edit to `navy.700` and the whole app follows. It's the design-system version of programming to an interface: components depend on a name, not a value. The honest caveat is the migration isn't 100% — a couple of older components still use stock Tailwind palettes, and those won't track a future rebrand until I finish moving them onto tokens.

**Q: Why hand-write an icon component instead of using a library or emoji?**
Emoji render differently on every OS, can't inherit text color, and clash with a real typeface. A library would work, but for a fixed set of about 25 icons I drew them into one `Icon` component on a shared 24×24 grid that strokes with `currentColor`. That gives me one consistent stroke weight everywhere and free theming — any `text-*` class colors the icon, because it inherits `currentColor`. No new dependency, tiny bundle, total control. If the set grew large I'd reconsider and pull in a library.

**Q: Your marketing landing page shows the product's charts. How did you keep it from lying about what the app looks like?**
I render the *actual* chart components — the same `RevenueTrendChart`, `TopItemsChart`, and `SalesHeatmap` the dashboard uses — and just feed them sample data shaped exactly like the real API, with money in cents. So if a chart's design changes, the landing page changes with it automatically; there's no screenshot to go stale. The tradeoff is the landing page now depends on those components staying prop-compatible, but I treat that as a good thing — a breaking change surfaces immediately at build time.

**Q: The dashboard KPI cards don't show trend percentages even though the mockups did. Why?**
Because the backend doesn't expose a previous-period comparison, so any "+8.4% vs last month" would be invented. I show the absolute values that are actually true and leave a comment explaining the delta is intentionally omitted until the API supports it. It's the same discipline we use for money on the backend — you don't fabricate a number just because the design has a slot for it.

**Q: You restyled the login and signup pages. How did you avoid breaking authentication?**
I extracted all the new layout — the split-screen, the brand panel, the tabs — into an `AuthShell` component that takes the form as children. The pages now just pass their existing form into the shell. The actual auth code — the `signIn`/`signUp` calls, error state, redirects — didn't change at all. Keeping the touched surface as small as possible is the whole strategy for a redesign: the less behavior you move, the less you can regress.

---

## What to look up if you want to go deeper
- **Design tokens** — the W3C Design Tokens Community Group format, and how Tailwind's `theme.extend` is a lightweight token layer. The concept (named, themeable values) is the same idea behind CSS custom properties and tools like Style Dictionary.
- **`currentColor` and SVG theming** — MDN on the `currentColor` keyword and on styling inline SVG; this is the mechanism that makes the icon component theme-for-free.
- **`font-variant-numeric` / tabular figures** — MDN's `font-variant-numeric`, and any typography primer on lining vs. old-style and tabular vs. proportional figures (why finance UIs use tabular).
- **`AbortController` + React effect cleanup** — the MDN `AbortController` docs and the React docs' "synchronizing with effects" / cleanup section; understand why you need *both* abort (cancel the request) and a cancelled flag (guard the late resolve).
- **Container vs. presentational components** — Dan Abramov's original "Presentational and Container Components" piece (and his later note softening it). This sprint is a clean case study in why the split makes a redesign cheap.
- **Recharts customization** — the Recharts docs for `AreaChart`/`linearGradient` defs and custom tooltip `contentStyle`, which is how `RevenueTrendChart` got its branded fill and rounded tooltip.
- **Web font loading performance** — `rel="preconnect"` and `display=swap` (MDN / web.dev "font best practices"); the `index.html` changes are a minimal version of this.

---

## Things you punted (named technical debt)
- **Design-token migration is incomplete.** `InsightsPanel.tsx` (per-category badges, `gray-*` skeletons) and `Onboarding.tsx` (stepper `bg-gray-200`/`text-gray-400`) still use stock Tailwind palettes instead of the new tokens. They render fine but won't follow a future rebrand. Finish moving them onto `navy`/`ink`/`line`/`pos`/`neg`/`warn`.
- **Topbar search and date range are decorative.** The "Search menu items…" input only holds local state — it filters nothing — and the "Last 30 days" chip is a fixed label with a chevron that opens no menu. Wire search to actually filter the menu table, and make the range selectable (which also requires backend support for arbitrary windows).
- **Logo is a placeholder.** `Logo.tsx` is a stand-in monogram; the comment says to swap the SVG when a real mark is delivered. Until then the brand identity is provisional.
- **Landing page links go nowhere.** The footer columns (About, Careers, Privacy, Terms…) and social icons are `cursor-pointer` spans/`<a>` with no `href`. Either build those pages or remove the dead affordances before this is public.
- **`useUnreadAlerts` refetches per session, not on alert changes.** The badge count is fetched once when the session is established; marking an alert read on the Alerts page won't update the sidebar/topbar count until a remount. A shared alerts store/context (or a refetch trigger) would keep the badge live.
- **Landing route is at `/welcome`, not `/`.** The marketing page isn't the front door — `/` still routes to the dashboard (gated to `/login` for signed-out users). Decide the intended public entry point; most products want the landing page at `/` with the app behind `/app` or similar.
- **No mobile pass on the dashboard chrome.** The sidebar is a fixed 248px column with no collapsed/drawer state, and the topbar hides search/date below `sm`/`md` rather than relocating them. The landing and auth pages are responsive; the signed-in app isn't really, yet.
- **Hardcoded marketing numbers in `AuthShell`.** The "$56k / 124 / 8.4%" stat figures on the auth brand panel are static copy. Fine as marketing, but worth labeling clearly as illustrative so nobody mistakes them for live data.
