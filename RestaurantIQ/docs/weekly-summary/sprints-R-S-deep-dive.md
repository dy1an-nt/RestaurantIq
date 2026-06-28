# RestaurantIQ — Sprints R & S: A Teaching Walkthrough

*Audience: an intermediate engineer who knows React and has used a database, and wants to understand this work well enough to defend it in an interview. This document is grounded in the actual code on disk, not just the sprint write-ups.*

---

## 1. The through-line: turning strong code into a trustworthy system

These two sprints share one thesis: **the codebase was already good; what it lacked was *trust* — both machine trust and human trust.** Neither sprint shipped a headline feature. That's the point.

The engineering review that kicked this off had a brutal one-liner: *"a genuinely strong codebase whose own quality gates are red."* Four tests were failing on a clean clone. `npm run lint` errored out because the config file didn't exist. There were high-severity vulnerabilities in production dependencies. There was no CI. So anyone who cloned the repo — a recruiter, a teammate, a future you — ran the tests, saw red, and concluded *"this doesn't actually work,"* even though it largely did. The gap between *is it correct* and *can you tell it's correct* was the whole problem.

**Sprint R (Reliability & Release)** closed that gap on the *machine* side. Green tests, a CI gate that runs them, working lint, zero high-severity prod vulns, validated inputs at every write route, and one audited multi-tenant boundary instead of twenty copy-pasted ones. The unifying idea: *make correctness verifiable and make the verification mandatory.*

**Sprint S (Pilot Readiness)** closed the same gap on the *human* side, in preparation for a 2–3 restaurant pilot. The product worked, but it didn't *explain itself*: the nav was cluttered with an engineering-only diagnostics page, there were three overlapping "margins" surfaces an owner couldn't tell apart, numbers had no provenance ("is this revenue with tax or without?"), and there were UI controls (a search box, a fake date-picker chevron) that looked interactive but did nothing. The unifying idea: *a number a user can't interpret is worse than no number, and a control that does nothing is a liability.*

So the two sprints are the same move applied to two audiences. Sprint R earns the *machine's* trust (the test runner, the auditor, the type checker). Sprint S earns the *owner's* trust (legible numbers, honest UI, an accessibility floor). Together they move the project from "impressive prototype" to "thing you can hand to a stranger." That's process and trust work, not feature work — and it's the kind of work senior engineers are actually evaluated on.

---

## 2. Concept deep-dives

### (a) Clock injection, and why a failing test pointed at a *production* bug

**What happened.** Four tests were failing on a fresh clone. The naive read is "flaky tests, fix the tests." The actual root cause was in production code. `refreshDailySummaries` — the function that rebuilds the dashboard's 30-day rollup — computed its window by reading the wall clock inline:

```ts
// before (conceptually)
const since = new Date();          // <-- reads "now" at call time
since.setDate(since.getDate() - 30);
```

The tests seeded orders on fixed dates (`2026-05-20/21`). As long as the real calendar was within 30 days of those dates, the window covered the seed data and the tests passed. Once the calendar moved past the window, the function *correctly* returned zero rows — there genuinely were no orders in the last 30 days — and the tests failed. Nothing was broken in the test; the test was a tripwire that fired late.

**The fix (the real one, in `persistence.ts:230`).** Make the instant a parameter:

```ts
export const refreshDailySummaries = async (
  restaurantId: string,
  now: Date = new Date(),   // default = real clock → production unchanged
): Promise<void> => {
```

Tests inject a fixed `now` anchored to the seed dates; production passes nothing and gets the real clock. The wall-clock coupling is gone, so the suite stops rotting with the calendar.

**Why this is the right call, and the tradeoff.** The team deliberately chose a *default parameter* over a full injectable "clock service" (a `Clock` interface wired through DI). For one function that needed it, a clock service is over-engineering — more indirection than the problem earns. The default-parameter form is the minimal version of the same idea: *dependency injection of time*. The cost is that it's not enforced globally — someone could still write `new Date()` inline elsewhere — but you don't pay for abstraction you don't need yet.

**The deeper lesson — why a test failure was a production smell.** The exact same wall-clock read is what would show a *real owner* a silently-empty dashboard after a lapsed sync. The function reading "now" with no way to reason about it is a correctness liability whether a test or a user hits it. A time-dependent test failing isn't a "test smell" to paper over — it's the test doing its job: surfacing hidden coupling to ambient global state. **Time, randomness, the filesystem, and the network are all ambient inputs; code that reads them implicitly is code you can't reason about deterministically.**

> **Interview soundbite:** "We had four tests failing on a clean clone. The temptation is to call them flaky and move on. But the fix belonged in production code, not the test: the aggregation function read `new Date()` inline to compute its 30-day window, so the window slid with the calendar. We made the instant an injectable parameter that defaults to the real clock — production is byte-for-byte the same, but tests pin a fixed `now`. The failing test wasn't noise; it was surfacing that our data layer was coupled to the wall clock, which is the same bug that would silently empty a user's dashboard."

---

### (b) `requireRestaurant`: middleware as a *security boundary*, not just DRY

**What it is.** In this app, the only thing tying a database row to its owner is `restaurants.user_id` (a NOT NULL foreign key to `auth.users`). Row-Level Security in Postgres is *bypassed* — the backend uses the Supabase service-role key, which sees all tenants' rows. So **tenant isolation is enforced in application code, every single time, or it leaks.** The canonical block was: *look up the `restaurants` row WHERE `user_id = <jwt sub>`, 404 if absent.* That block was copy-pasted across ~20 call sites (four times in `analytics.ts` alone).

`requireRestaurant` (in `middleware/requireRestaurant.ts`) collapses all of them into one Express middleware. Mounted after `authMiddleware`, it reads `req.user.sub` (the user id from the verified JWT), runs the one scoped query, and on success attaches `req.restaurantId` and `req.restaurant` to the request, then calls `next()`. On failure it returns the standard envelope: 401 if there's no user, 404 if no restaurant, 500 on a query error.

You can see the payoff in `analytics.ts:35`:

```ts
router.use(authMiddleware);
router.use(requireRestaurant('id, doordash_commission_bps, doordash_flat_fee_cents'));
```

Every route below those two lines can now trust `req.restaurantId` exists and belongs to the caller. The `columns` parameter is a nice touch: analytics needs the DoorDash economics fields, so it asks for them in the *same* query it already pays for — no route re-fetches the restaurant it just resolved.

**Why this is a security control and not merely "less duplication."** DRY is about maintainability. This is about *attack surface*. Twenty copies of the tenancy check means twenty independent chances to forget the `.eq('user_id', sub)`, or scope by a client-supplied id instead of the token's `sub`, or return the wrong status. Each copy is a place a cross-tenant leak can hide. Collapsing it means **one implementation to audit and one place to review** — a security reviewer reads ~30 lines once instead of grepping 20 sites and reasoning about each. The duplication *was* the vulnerability surface; removing it shrinks the surface.

**The tradeoff, stated honestly.** The middleware was *deliberately not* forced onto every `user_id` lookup. 12 of 23 lookups collapsed into it; 11 stayed. The holdouts are the restaurant-CRUD resource itself (where the restaurant *is* the thing being created/read) and the integrations/menu-item routes, which do **body/param-based ownership checks** — they verify ownership of a specific resource id from the request, return **403** (not 404), and need token columns. Forcing the middleware there would have changed API contracts (404 vs 403 leak different information to an attacker) for no real gain. The skill on display is knowing that "two things look similar" doesn't mean "merge them" — these have genuinely different *semantics*.

> **Interview soundbite:** "Our backend bypasses Postgres row-level security and uses a service-role key, so tenant isolation is enforced in code on every request. The check — resolve the restaurant where `user_id` equals the JWT's subject — was copy-pasted ~20 times, and every copy is a chance to leak across tenants. We pulled it into one middleware that runs after auth and attaches `req.restaurantId`. That's not really a DRY refactor; it's collapsing the multi-tenant attack surface into one auditable spot. We left ~11 lookups alone on purpose, because those are resource-level ownership checks that return 403, not 404 — different semantics, different status codes, so merging them would've been wrong."

---

### (c) Schema validation at the edge: `validateBody(schema)` replacing `req.body`

**What it is.** `middleware/validate.ts` is a tiny factory: `validateBody(schema)` returns an Express middleware that runs `schema.safeParse(req.body)`. On failure it returns the project's standard 400 envelope with a readable, field-scoped message. On success — and this is the load-bearing line — it does:

```ts
req.body = result.data;   // replace raw body with the parsed, coerced, trimmed value
next();
```

Zod was already a dependency, but it was only used in `config/env.ts`. Request bodies were validated inconsistently: one route (`delivery-economics`) had a thorough ~45-line hand-rolled validator, `menu-items` had ~60 lines of per-field checks, and several routes (like `createRestaurant`) just trusted the body. Sprint R put Zod on all 13 write routes through this one middleware.

**Why replacing `req.body` matters more than just "rejecting bad input."** There are two things going on:

1. **A trust boundary.** After the middleware runs, there is *no code path to the handler with raw, untrusted input.* The handler and the service layer beneath it can *assume* their inputs are well-formed. That's a huge reasoning win: in `chat.ts:150` the handler can write `const { content } = req.body` and *know* `content` is a trimmed, non-empty, ≤2000-char string, because the schema (`chat.ts:30`) guaranteed it. The validation lives at the system boundary, so the interior gets to be simple.

2. **Coercion and narrowing, not just checking.** Zod doesn't only *validate*, it *transforms*: `.trim()` strips whitespace, `.strict()` strips/rejects unknown keys, defaults fill in. By assigning `result.data` back, the handler sees the *cleaned* value, not the original. Look at `analytics.ts:42` — the `deliveryEconomicsSchema` uses `.strict()` to reject unknown fields (preserving the old hand-rolled behavior) and `.refine()` to enforce "at least one field present." That's business logic that used to be 45 lines of imperative checks, now declared in ~12 lines next to the route it guards.

**The tradeoff.** Centralizing into one middleware means the *error shape* is uniform (good for the frontend, which assumes the `{ data, error }` contract), but it also means every write route now needs a schema written and kept in sync with the DB. That's deliberate friction: you can't add a write route and forget to validate it, because the pattern is "mount `validateBody` or you're the odd one out." The alternative — per-handler `if (!body.x) return 400` — is where inconsistency breeds.

> **Interview soundbite:** "Validation lives in middleware, not the controller, and the key move is that it *replaces* `req.body` with the parsed result. Zod doesn't just check the shape — it trims, strips unknown keys, applies defaults — so the handler receives a clean, typed value and the service layer underneath can assume its inputs are valid. There's no path to the handler with raw input. We standardized it across all 13 write routes, which let us delete about 100 lines of hand-rolled per-field checks and, more importantly, made every 400 response look the same, which the frontend's `{ data, error }` contract depends on."

---

### (d) CI as the *actual* deliverable (the tests already existed)

**What it is.** `.github/workflows/ci.yml` runs on every push to `main` and every pull request. Two parallel jobs: **backend** (typecheck · lint · test · prod audit) and **frontend** (typecheck · lint · prod audit). The audit step is `npm audit --omit=dev --audit-level=high` — it fails the build on a high-or-critical vulnerability *in production dependencies only* (dev-only vulns don't ship, so they don't block).

**Why this is the headline of the sprint even though it adds zero behavior.** The tests were already written, and they were good — 167 of them. Lint had a script and plugins. The missing piece was *a thing that runs them without a human remembering to.* The CI file's own header comment names the failure mode precisely: *"Before this existed, nothing ran the tests, typecheck, lint, or audit before code reached main — which is how a red test suite and a dead lint script landed unnoticed."* The gap was never code quality. It was **the absence of a gate.** Process, not engineering, was the hole.

This is a genuinely senior insight: *the deliverable was the enforcement, not the thing being enforced.* A test suite that nobody runs is documentation at best; a test suite that *blocks merge when red* is a guarantee. CI converts "we have tests" (a claim) into "broken code can't reach main" (an invariant).

**Two implementation details worth noticing:**
- The repo is **doubly nested** (git root → `RestaurantIQ/` → app packages), so each job sets its own `working-directory` and `cache-dependency-path`. This is the kind of mundane thing that breaks CI for an afternoon if you don't get it right.
- `concurrency: cancel-in-progress: true` cancels superseded runs on the same ref, so a fresh push doesn't queue behind a stale one. Small, but it's the difference between a snappy and a sluggish feedback loop.
- `npm ci` (not `npm install`) — clean, lockfile-pinned installs, so CI tests the *exact* dependency tree the lockfile describes, not a freshly-resolved one.

> **Interview soundbite:** "The most valuable thing we shipped that sprint added no features and no tests — it was the CI pipeline. We already had 167 passing tests; what we didn't have was anything that ran them before code hit main. That's literally how a red suite and a broken lint script got to main in the first place — the author just had to remember, and didn't. CI turns 'we have tests' from a claim into an invariant: typecheck, lint, test, and a prod-only `npm audit` gate every PR. The lesson is that quality gates are worthless until they're mandatory and automated."

---

### (e) Labeling vs. reconciling money: a data-modeling *and* trust decision

**The problem.** The app has two legitimate notions of "revenue" that *don't* match:
- The dashboard's "30-Day Revenue" headline sums `daily_summaries.total_revenue_cents`, which is **line-item revenue** = Σ(quantity × unit price).
- The Orders view and the heatmap use `orders.total_cents`, which is **POS gross** — what Square actually charged, including tax, tips, and discounts.

These differ for real reasons (tax/tips/discounts aren't line items). An owner comparing the dashboard headline against their Square dashboard will see a gap and — reasonably — distrust the whole product.

**The decision: label it, don't reconcile it.** Reconciling would mean schema and ingestion changes — modeling tax/tips/discounts as first-class fields, re-deriving summaries — which is risky and out of scope for a reliability sprint. Instead, the dashboard now carries a **methodology note** explaining exactly what the headline number does and doesn't include, and Sprint S went further with `InfoTooltip`s on all four KPIs and the three chart sections, making the line-item-vs-order-total distinction explicit *at the point of confusion*.

**Why "label" is the right call here, and why it's honest rather than lazy.** The review itself flagged this as the **#1 MVP trust risk** and recommended the label path as the lower-risk fix. The reasoning: *a number the user understands the provenance of is trustworthy even if it differs from another number; a number with no provenance is untrustworthy even if it's "right."* The gap between the two revenue figures is real and defensible — what was broken was that nothing *explained* it. Labeling fixes the actual defect (missing provenance) without touching the riskier machinery (the data model). The reconciliation work is explicitly logged as a remaining Phase-3 risk, not quietly dropped.

This connects to a broader money-handling discipline in the codebase: **everything is integer cents from DB → API → display.** `lib/format.ts` is the single source of truth for turning cents into strings (`formatCents`, `formatDollars`), replacing ~9 subtly-different copies. Floats are forbidden for money because IEEE-754 addition isn't associative — sum enough small floats and you drift. So the money story across these sprints is two-pronged: *represent it exactly* (cents, centralized formatting) and *explain what each figure means* (labels, tooltips).

> **Interview soundbite:** "We had two revenue numbers that didn't match — line-item revenue on the dashboard versus POS gross on the orders view. They differ legitimately, because gross includes tax and tips. The tempting fix is to reconcile them, but that's a schema and ingestion change, and risky. We decided to *label* instead: a methodology note plus tooltips that say exactly what each figure includes. The principle is that a number with clear provenance is trustworthy even when it differs from another number, but a number with no provenance is untrustworthy even when it's correct. We logged the real reconciliation as known debt rather than pretending we'd solved it."

---

### (f) The embedded-prop page-consolidation pattern

**What it is.** "Margins" (item-level profitability) and "Channel Margins" (in-house vs. DoorDash after commission) were two separate nav destinations. An owner couldn't tell why they were different things. Sprint S merged them into **one `/margins` page with two tabs** (`pages/Margins.tsx`), and made `/channel-margins` redirect to `/margins`.

The clever part is *how* it reuses the existing pages. The two original page components — `MarginAnalysis` and `ChannelMargins` — were not rewritten. They each gained one optional prop, `embedded`, and `Margins.tsx:71` renders them as:

```tsx
{tab === 'item' ? <MarginAnalysis embedded /> : <ChannelMargins embedded />}
```

When `embedded` is true, the child component **drops its own page title** (the `<h1>` and subtitle) and lets the parent shell own the heading. Everything else — the data fetching, the tables, the empty states — runs unchanged.

**Why this pattern, instead of the obvious alternatives?**
- *vs. rewriting one big component:* you'd merge two working, tested data flows into one, risking regressions in both, for purely presentational gain.
- *vs. a shared layout wrapper:* heavier; you'd have to hoist both data flows up. The `embedded` flag is a one-line change per child that preserves each component as a self-contained, independently-routable unit.

The `embedded` prop is essentially a small **inversion of control**: the child cedes ownership of one concern (its title/chrome) to whoever renders it, so the same component works both as a standalone page *and* as a tab panel. It's the minimal seam that makes a component composable without restructuring it. The cost is a tiny bit of conditional rendering inside each child; the benefit is zero behavior risk and two fewer nav items.

It also pairs with proper ARIA tab semantics (`role="tablist/tab/tabpanel"`, `aria-selected`, `aria-controls`) — see section (g) — so the consolidation improves accessibility rather than regressing it.

> **Interview soundbite:** "We had two margin pages an owner couldn't distinguish, so we merged them into one tabbed page. The thing I'd highlight is that we didn't rewrite either component — we gave each an `embedded` prop that just suppresses its own title so the tab shell can own the heading. The components still work as standalone routes; they also work as tab panels. It's a tiny inversion of control — the child cedes its chrome to its parent — and it gets you the UX consolidation with essentially zero risk to the two data flows underneath."

---

### (g) Accessibility done properly: keyboard + screen reader, not hover-only

Sprint S did a real accessibility pass, and the distinction worth understanding is **hover-only vs. genuinely accessible.** A tooltip that only appears on mouse hover is invisible to keyboard and screen-reader users — it's not an accessibility feature, it's a mouse feature.

`components/InfoTooltip.tsx` is the model. Look at what makes it correct:
- The trigger is a **real `<button>`**, so it's in the tab order and operable by keyboard — not a `<span>` with an `onClick`.
- The bubble opens on **`onFocus` as well as `onMouseEnter`**, so tabbing to it reveals the explanation. Escape (`onKeyDown`) dismisses it.
- **`aria-describedby`** ties the bubble (via a `useId()`-generated id) to the button, so a screen reader announces the explanation as the button's description. The bubble has `role="tooltip"`.
- `aria-describedby` is only set *while open* (`open ? id : undefined`), so the relationship is announced when relevant.

The same rigor shows up across the sprint:
- The dev-mode toggle in `Settings.tsx` is a proper **`role="switch"` with `aria-checked`**, not a styled div — assistive tech announces it as a switch and reads its on/off state.
- The Margins tabs use **`role="tablist/tab/tabpanel"`** with `aria-selected` and `aria-controls`/`aria-labelledby` wiring the tab to its panel.
- Icon-only controls get `aria-label`s (the alerts bell *including its unread count*, the avatar → settings link, sign-out).
- **App-wide:** a skip-to-content link, `<nav aria-label>` landmarks, a focusable `<main>`, and `focus-visible` rings on every interactive element so keyboard focus is *visible*.

**Why `focus-visible` and not `focus`?** `:focus-visible` only shows the ring when the browser heuristically decides focus came from the keyboard, so mouse users don't get rings they don't need while keyboard users always do. It's the modern resolution of the old "remove the ugly outline" vs. "keep it for accessibility" fight.

The underlying concept: **the accessibility tree is a parallel API.** Sighted mouse users consume the visual rendering; screen-reader and keyboard users consume the semantic tree (roles, names, states, relationships). `aria-*` attributes and correct native elements are how you populate that second API. Hover handlers populate neither.

> **Interview soundbite:** "Our info tooltips aren't hover-only, which is the usual mistake. The trigger is a real button so it's in the tab order; the bubble opens on focus, closes on Escape, and is wired to the button with `aria-describedby` so a screen reader announces it. Same idea for the dev toggle — it's a `role='switch'` with `aria-checked`, not a styled div — and the tabs use proper tablist roles. The mental model is that the accessibility tree is a second API: mouse users read the pixels, assistive-tech users read roles, names, and states, and your job is to populate both. And we used `focus-visible` rather than `focus` so keyboard users always see focus rings without inflicting them on mouse users."

---

### (h) Dev-mode flag: a UX guard that is explicitly *not* a security boundary

**What it is.** Sync Health is a distributed-scheduler observability page — leader election, retry metrics — that's useful to an *engineer* and meaningless to a restaurant owner. Sprint S removed it from the owner nav and revealed it only when **Settings → Developer → Show developer tools** is on. That flag (`lib/useDevMode.ts`) lives in `localStorage` under `riq_dev_mode`. The `Sidebar` conditionally appends the Developer nav section when the flag is on (`Sidebar.tsx:72`).

A nice React detail: flipping the flag dispatches a **custom event** (`riq-dev-mode-change`) so the sidebar re-renders immediately *in the same tab*, and the hook also listens for the native `storage` event so the change propagates *across tabs*. (The native `storage` event only fires in *other* tabs, which is exactly why the custom event is needed for the current one.) That's the standard pattern for making `localStorage` reactive in React, where it isn't a hook-friendly reactive store by default.

**The critical caveat, stated in the code itself.** The route still loads if you navigate to `/sync-health` directly — the flag only hides the *nav link*. The hook's comment and the sprint doc both say it outright: **"it's a UX guard, not a security boundary."** And that's *correct*, not a bug, for two reasons:
1. `localStorage` is fully client-controlled. Anyone can open devtools and set `riq_dev_mode` to `'1'`. A flag the client can flip can never gate anything that matters.
2. Sync Health exposes *operational diagnostics*, not another tenant's data. The real protection on any data it fetches is still the backend's `authMiddleware` + `requireRestaurant` — the same tenant boundary as every other route. The dev flag isn't protecting data; it's **reducing cognitive load** for the 99% of users (owners) who'd be confused by a scheduler page.

**Why this distinction is the whole point.** Conflating "hidden from the menu" with "secured" is a classic and dangerous mistake — it's security theater. The honest framing is: *this flag decides what's worth showing, not what's allowed.* Visibility is a UX concern handled on the client; authorization is a security concern handled on the server, and never the twain shall meet. If Sync Health *did* leak cross-tenant data, hiding the nav link would be worthless — you'd need server-side authorization.

> **Interview soundbite:** "We hid an engineering-only diagnostics page behind a localStorage dev-mode flag, and the important thing is we documented in the code that it is *not* a security boundary. The route still loads if you type the URL — the flag only hides the nav link. That's fine, because a client-side flag can be flipped in devtools in two seconds, so it can never gate anything sensitive. The page's actual protection is the same server-side auth and tenant middleware as everything else. The flag is purely about cognitive load — keeping a scheduler observability page out of a restaurant owner's face. Conflating 'hidden from the menu' with 'secured' is security theater, and we were careful not to."

---

## 3. Interview question bank

**1. Four tests fail on a fresh clone but pass on your machine from last month. Walk me through it.**
That's the classic time-bomb signature. In our case the aggregation function read `new Date()` inline to compute a trailing-30-day window, and the tests seeded fixed dates; once the calendar passed the window, the function correctly returned zero rows and the tests failed. The fix went in *production* code: we made the instant an injectable parameter defaulting to the real clock, so prod is unchanged but tests pin a fixed `now`. The general principle: time, randomness, network, and filesystem are ambient inputs, and code that reads them implicitly can't be reasoned about deterministically. A time-dependent test failing is the test doing its job.

**2. You have a multi-tenant app with RLS disabled and a service-role key. How do you prevent cross-tenant leaks?**
Every query has to be scoped to the caller's tenant in application code, because the database won't do it for you. We derive the restaurant from the JWT's `sub` claim — never from a client-supplied id — and we collapsed that resolution into one middleware, `requireRestaurant`, that runs after auth and attaches `req.restaurantId`. Centralizing it means one place to audit instead of twenty copy-pasted checks, each of which was a chance to leak. The tradeoff is that correctness lives in code rather than the DB, so the right long-term move past a handful of tenants is to turn RLS back on as a backstop — defense in depth.

**3. Why put validation in middleware instead of the controller, and why replace `req.body`?**
Middleware makes validation a boundary the request must cross, so there's no code path to the handler with raw input. Replacing `req.body` with the Zod-parsed result matters because Zod *transforms* — trims strings, strips unknown keys, applies defaults — so the handler and service layer see clean, typed values and can assume validity. It also gives every 400 a uniform shape, which our frontend's `{ data, error }` contract depends on. We standardized it across all 13 write routes and deleted ~100 lines of hand-rolled checks in the process.

**4. Your tests already pass. Why is adding CI the most valuable thing you did that week?**
Because passing tests are a claim until something enforces them. We had 167 good tests and nothing that ran them before merge — which is exactly how a red suite and a broken lint script reached main. CI converts "we have tests" into the invariant "broken code can't reach main." The deliverable wasn't the tests or the lint rules; it was making them mandatory on every push and PR. Process was the gap, not code.

**5. Two numbers in your product disagree. A user notices. What do you do?**
First figure out if they disagree for a legitimate reason. Ours did: dashboard revenue was line-item totals, the orders view was POS gross including tax and tips. The instinct is to reconcile them, but that was a risky schema and ingestion change. We labeled instead — a methodology note plus tooltips explaining exactly what each figure includes — because a number with clear provenance is trustworthy even when it differs, and a number with no provenance isn't trustworthy even when it's right. We logged the real reconciliation as known debt instead of hiding it.

**6. How do you handle money in this system, and why not floats?**
Integer cents everywhere — database, API, and display — formatted to a string only at the very end, through one shared `format.ts` helper instead of nine slightly-different copies. Floats are out because IEEE-754 addition isn't associative; summing many small floating-point amounts accumulates drift, which is unacceptable for money. Square hands us BigInt amounts that we coerce to Number when writing to integer columns.

**7. You need to merge two similar pages into a tabbed view without risking the existing logic. How?**
We gave each existing page component an optional `embedded` prop that just suppresses its own title, then rendered them as tab panels under a shell that owns the heading. The data flows stayed untouched, so there was almost no regression risk, and each component still works as a standalone route. It's a small inversion of control — the child cedes its chrome to whoever renders it — which is the minimal seam that makes a component composable without restructuring it.

**8. What makes a tooltip actually accessible, versus just visually present?**
The trigger has to be a real focusable element — a button, not a span with onClick — so it's in the tab order. It has to open on focus, not just hover, and dismiss on Escape. And the bubble has to be tied to the trigger with `aria-describedby` and a `role="tooltip"` so a screen reader announces it. Hover-only tooltips are invisible to keyboard and screen-reader users. The model is that the accessibility tree is a second API: you populate it with roles, names, states, and relationships, and hover handlers populate none of that.

**9. You hid an admin page behind a localStorage flag. Is that secure?**
No, and we documented that in the code. localStorage is client-controlled — anyone can flip the flag in devtools — so it can never gate anything sensitive. The route still loads directly; the flag only hides the nav link. That's acceptable because the page's real protection is the same server-side auth and tenant middleware as every route, and it exposes diagnostics, not another tenant's data. The flag is purely a UX guard to reduce cognitive load. Conflating "hidden from the menu" with "authorized" is security theater.

**10. How do you make a `localStorage` value reactive across a React app and across browser tabs?**
localStorage isn't a reactive store, so you bridge it with events. On write, dispatch a custom event that the current tab listens for, so its components re-render immediately — the native `storage` event doesn't fire in the tab that made the change. Then *also* listen for the native `storage` event, which *does* fire in other tabs, to stay in sync across tabs. Our `useDevMode` hook does both, and wraps localStorage access in try/catch because it throws in some private-browsing modes.

**11. Your CI audit step is `npm audit --omit=dev --audit-level=high`. Why those flags?**
`--omit=dev` because dev-only dependencies don't ship to production, so a vuln in a test or build tool shouldn't block a release — you'd get alert fatigue and start ignoring the gate. `--audit-level=high` because failing on low/moderate advisories, many of which are noise or unreachable, trains people to bypass CI. You want the gate to fire on things that genuinely matter — high and critical in code that actually ships — so that when it's red, people take it seriously.

**12. A reviewer says "turn on all the strict ESLint rules." Why might you not?**
A lint config is a quality gate, not a style crusade. We deliberately left `no-explicit-any` off because our data layer — PostgREST embeds, raw Square/DoorDash payloads — is genuinely dynamically shaped, so `any` there is a reviewed tradeoff, not an accident; tightening it is tracked separately. We also kept `no-console` off because we use `console.error` for structured operational logging in ~147 deliberate places. Every relaxation has a one-line rationale in the config so it's auditable, not silent. The goal is a gate that catches real bugs — unused vars, dead code, shadowing — without generating a 200-finding cleanup nobody asked for, because a gate everyone overrides protects nothing.

---

## 4. What to study next to go deeper

**Testing & determinism**
- Search the testing literature for **"test doubles" and "controlling the clock"** — Martin Fowler's articles on test doubles and on the *Clock* / *humble object* patterns are the canonical treatment of injecting time, randomness, and I/O. Our default-parameter clock is the lightweight version of this.
- Gerard Meszaros, *xUnit Test Patterns* — the source for "fresh fixture," "test smell," and why nondeterminism is a test design failure.

**Multi-tenancy & authorization**
- **Postgres Row-Level Security** docs, and Supabase's RLS guide. We *bypass* RLS today; understanding what it would enforce tells you exactly what our app code is responsible for, and what the "turn RLS back on as a backstop" follow-up buys you.
- Read about the **principle of least privilege** and the distinction between *authentication* (who are you — our JWT/JWKS layer) and *authorization* (what may you touch — our tenant scoping). They're separate concerns that are easy to conflate.

**Validation & parsing**
- **Zod** docs, specifically `.transform`, `.refine`, `.strict`, and `.safeParse` — we use all four. Then read Alexis King's essay **"Parse, don't validate"**, which is the theoretical backbone for *why* replacing `req.body` with the parsed value (narrowing the type at the boundary) beats checking-and-passing-through.

**CI/CD & supply chain**
- **GitHub Actions** docs on `concurrency`, matrix/parallel jobs, and dependency caching — our workflow uses concurrency cancellation and per-package cache paths.
- The difference between **`npm ci` and `npm install`**, and how `npm audit` severity levels and `--omit=dev` work. Then read about **reproducible builds** and why lockfile-pinned installs matter in CI.

**Accessibility**
- The **WAI-ARIA Authoring Practices Guide (APG)** — the reference patterns for *tabs*, *switch*, *tooltip*, and *disclosure*. Our `InfoTooltip`, dev-mode switch, and Margins tabs are implementations of these patterns; reading the APG shows you the full keyboard-interaction contracts (e.g. arrow-key navigation between tabs, which is a reasonable next improvement).
- MDN on **`:focus-visible`** and the **accessibility tree** — the "second API" mental model.

**Money & numerics**
- Read up on **IEEE-754 floating point** and why `0.1 + 0.2 !== 0.3`, and the general advice to **store money as integer minor units**. Martin Fowler's *Money* pattern (from *Patterns of Enterprise Application Architecture*) is the classic write-up.

**Frontend state plumbing**
- MDN on the **`storage` event** and the **CustomEvent** API — the exact mechanism `useDevMode` uses to make localStorage reactive within and across tabs, including the subtlety that `storage` doesn't fire in the originating tab.

---

### Files referenced

Backend:
- `restaurantiq-backend/src/services/ingestion/persistence.ts` — injected clock (`refreshDailySummaries`), upsert-then-prune summary rebuild
- `restaurantiq-backend/src/middleware/requireRestaurant.ts` — tenant-isolation boundary
- `restaurantiq-backend/src/middleware/validate.ts` — `validateBody` (replaces `req.body`)
- `restaurantiq-backend/src/types/express.d.ts` — global Request augmentation
- `restaurantiq-backend/.eslintrc.cjs` — gate-not-crusade lint config
- `restaurantiq-backend/src/routes/analytics.ts`, `restaurantiq-backend/src/routes/chat.ts` — refactored routes

Infra:
- `.github/workflows/ci.yml` — the CI gate (at the git root, one level above `RestaurantIQ/`)

Frontend:
- `restaurantiq-frontend/src/lib/format.ts`, `.../src/lib/useLastSynced.ts`, `.../src/lib/useDevMode.ts`
- `.../src/components/InfoTooltip.tsx`, `.../src/components/EmptyState.tsx`, `.../src/components/LastSyncedIndicator.tsx`, `.../src/components/Sidebar.tsx`
- `.../src/pages/Margins.tsx`, `.../src/pages/Settings.tsx`

Sprint sources:
- `docs/weekly-summary/week-R.md`, `docs/weekly-summary/week-S.md`

> **Accuracy note:** `daily_summaries` is rebuilt via **upsert-first, then prune stale rows** (not delete-then-reinsert), deliberately — so that if the write fails the previous data is preserved (no delete happens before a successful upsert).
