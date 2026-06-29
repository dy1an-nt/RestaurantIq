# Sprint T — Intelligence & Actionability

**Theme:** Increase the value of existing insights. Every change answers one
question — *"What action should the restaurant owner take next?"* No new
integrations, models, or dashboards. We used the data we already had, better.

---

## 1. What changed (file by file)

| File | Change |
|------|--------|
| `restaurantiq-backend/src/services/anthropicService.ts` | Redesigned the AI insight contract. Each insight now carries `priority` (high/medium/low), `title`, `explanation`, `metric`, `impact`, `action`, and `link`. The model assigns priority and the investigate-link directly; results are re-sorted most-important-first server-side. Count reduced from 5–8 to **3–6**. |
| `restaurantiq-backend/src/routes/insights.ts` | Added an explainability `meta` block to the response: period analyzed, days with data, items, orders, a data-volume-derived `confidence`, the data source, and `generatedAt`. |
| `restaurantiq-frontend/src/components/InsightsPanel.tsx` | Rebuilt the card around the five owner-facing fields, dropped the fragile keyword-regex priority guesser in favor of the AI's `priority`, added a one-click **investigate link** per card, an **explainability bar**, and a "What to do next" executive summary. |
| `restaurantiq-frontend/src/components/DashboardPriority.tsx` *(new)* | "Needs attention today" strip for the dashboard — surfaces the single most urgent unread alert with a type-specific action link, plus a calm "all clear" state. |
| `restaurantiq-frontend/src/pages/Dashboard.tsx` | Reordered to answer the owner's three questions in turn (attention → how am I doing → detail) and removed the duplicate revenue-methodology note. |

---

## 2. Insight Review (T1, T2)

### Prioritization strategy
Priority moved from the **frontend guessing** it (a 40-line regex matching words
like "fell", "spike", "promot") to the **AI assigning** it as a typed enum. The
prompt reserves `high` for the 1–2 insights with the largest dollars at stake or
real urgency; `medium` = act this week; `low` = monitor. The backend then
*guarantees* the ordering with a stable sort, so the most valuable card is always
first on the page and in the dashboard summary. Owners no longer get ten
equally-weighted recommendations.

### Removed
- **The regex priority deriver** (`derivePriority`) — replaced by AI-assigned
  priority. It was brittle and produced wrong labels whenever wording drifted.
- **The "Action for tomorrow morning" framing** — replaced with a neutral
  "Recommended action" plus a real link, so the action is *doable now*, not aspirational.
- **The dashboard revenue-methodology paragraph** — duplicate of the 30-Day
  Revenue KPI tooltip.

### Merged
- "What happened" + "metric" collapsed into a single **Supporting numbers**
  block, and the headline now carries a one-sentence **explanation** so the card
  reads top-to-bottom: *title → why → numbers → impact → action → link*.

### Rewritten
- The system prompt now demands six short fields per insight, caps the list at
  6, and tells the model to never pad to hit a count ("fewer, sharper" wins).
- Every insight must state an **expected business impact** in concrete terms
  ("~$2,000/week at risk", "+8% attach rate") — previously absent.

---

## 3. Connect insights to the product (T3)

Every card and the executive summary now render a labelled button that deep-links
to the page that explains the insight:

| `link` value | Button | Route |
|---|---|---|
| `analytics` | See Analytics | `/analytics` |
| `forecast` | Open Forecast | `/advisor` |
| `margins` | Review Margins | `/margins` |
| `menu` | View Menu Performance | `/` |
| `alerts` | View Alerts | `/alerts` |

**Clicks to investigate an insight: 1** (was: indeterminate — the user had to
guess where the number came from and navigate manually).

---

## 4. AI explainability (T4)

A transparency bar sits directly under the summary:

> **Analyzed:** Square + DoorDash sales · 23 days of data · 1,204 orders · 47 items · `high confidence` · Generated Jun 28, 2:14 PM

- **Which data / period / volume** — derived from the exact rows sent to Claude.
- **Confidence** — keyed off distinct days of history (≥21 high, ≥10 medium, else
  low), so it reflects real signal strength rather than a number the model made up.
- **Freshness** — `generatedAt` timestamp.

---

## 5. Dashboard focus (T5)

Sections now map 1:1 to the owner's three questions and are ordered by urgency:

1. **Needs attention today** (`DashboardPriority`) — *what needs attention / what to do next.*
2. **KPIs** — *how is my restaurant doing.*
3. **Menu table** — the detail behind it.

The priority strip is sourced from the **cheap, real-time alerts feed**, not the
rate-limited/billed AI endpoint — so opening the dashboard never burns AI quota,
and the strip and the AI Insights page stay consistent (both rank by the same
severity→priority logic).

**Duplicate information removed:** revenue methodology paragraph (now only in the
KPI tooltip). **Dashboard sections simplified:** methodology note dropped; one
focused attention strip added.

---

## 6. UX metrics

| Metric | Before | After |
|---|---|---|
| Clicks to investigate an insight | manual navigation | **1** |
| Insights shown | 5–8 | **3–6** (highest-value first) |
| Priority accuracy | keyword regex (guessed) | AI-assigned, typed enum |
| Fields per recommendation | 3 (title, rec, metric) | 5 owner-facing + priority + link |
| Explainability surfaced | none | period, volume, confidence, timestamp |
| Dashboard sections | 4 (incl. duplicate note) | 3, urgency-ordered |

---

## 7. Manual QA — cross-surface consistency

- **AI Insights:** priority chip, impact, action, and investigate-link render;
  cards sorted high→medium→low; explainability bar populated; empty/error/loading
  states intact.
- **Dashboard:** priority strip shows the top unread alert with a matching action;
  "all clear" state when none; KPIs and menu table unaffected.
- **Consistency:** both the dashboard strip and AI Insights rank by the same
  severity/priority ordering, so they never contradict each other. Margins,
  Forecast, and Analytics are the link targets — no recommendation points at a
  page that doesn't exist.

**Automated checks:** backend + frontend `tsc --noEmit` clean, eslint clean on
all changed files, frontend production build passes. *Live AI output should be
spot-checked once against a seeded restaurant with ≥3 days of data — the contract
and rendering are verified, the model's wording is not machine-checkable.*

---

## Definition of Done — status

- ✅ AI recommendations are concise (3–6, capped fields) and actionable (every card has an action + link).
- ✅ Every recommendation explains why it exists (one-sentence explanation + supporting numbers + explainability bar).
- ✅ Users navigate from an insight to supporting data in one click.
- ✅ Dashboard information is prioritized (urgency-ordered, attention strip first).
- ✅ RestaurantIQ now leads with *what to do next* rather than only showing metrics.
