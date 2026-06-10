# Week P — AI Chat, Purchasing Advisor & First Production Deploy

> Sprints A through O built the substrate: ingestion, schedulers, alerts, security headers, a design system. Sprint P is the first sprint where RestaurantIQ stops looking like an analytics dashboard and starts looking like a *product*. Two genuinely new surfaces shipped — a conversational AI grounded in the restaurant's actual data, and a weekly purchasing forecast where statistics do the math and Claude writes the plan — and the whole thing went live on Railway and Vercel for the first time. The latter took most of the day, mostly because of three small config files that didn't exist yet.

---

## Sprint goal in one sentence
Ship two AI-powered features that differentiate RestaurantIQ from generic analytics — a grounded multi-turn chat (`/chat`) and a stats-plus-narrative purchasing advisor (`/advisor`) — and put the whole stack in production on Railway + Vercel for the first time.

## What shipped, in plain English
- A restaurant owner can now ask plain-English questions about their own data ("why did revenue drop Tuesday?", "what should I cut from the menu?") and get back answers with real numbers from their last 28 days. Conversations persist so you can ask follow-ups.
- A weekly **Purchasing Advisor** page shows a per-item forecast — projected units and revenue for the next 7 days, vs. actual last 7 — alongside a Claude-written narrative ("stock up on chicken, cut the Garden Salad orders") that explains the math in business language.
- Both features are cost-controlled: chat has a 50-message-per-day cap per restaurant, and the advisor result is cached for 24 hours so the LLM only runs when the owner explicitly hits "Refresh forecast."
- A "forgot password" / "reset password" flow shipped alongside, both wearing the Sprint O auth shell.
- The backend is now deployed on **Railway**, the frontend on **Vercel**, and they talk to each other — the first time RestaurantIQ has existed outside `localhost`.
- Four custom Claude Code sub-agents (architect, devops, plus the existing backend/frontend/qa/teaching) are now codified in `.claude/agents/` so future sprints follow the same workflow consistently.

---

## File-by-file (every file touched, what it is + why it exists)

### Database (migrations 021–023)

- **`migrations/021_chat_conversations.sql`** (new) — Two tables. `chat_conversations` is one row per thread (`restaurant_id`, `title`, `created_at`, `updated_at`); `chat_messages` is one row per message (`conversation_id`, `restaurant_id`, `role` ∈ {`user`,`assistant`}, `content`, `context_meta` JSONB, `input_tokens`, `output_tokens`). Two design notes: (1) `restaurant_id` is **denormalized** onto `chat_messages` so the daily-cap count and tenancy checks never need to join — same pattern `alerts` uses; (2) two indexes — `(conversation_id, created_at ASC)` for thread reads, and `(restaurant_id, role, created_at DESC)` purpose-built for the daily-cap query. Both FKs cascade so deleting a conversation wipes its messages atomically.
- **`migrations/022_forecast_cache.sql`** (new) — One row per generated forecast: `restaurant_id`, full `payload` JSONB (items + insufficient list + narrative), token counts, the window the forecast was computed over (`trailing_days`, `projection_days`), `generated_at`. We store the **entire** computed result as JSONB so the GET endpoint is a single row read — no joins, no recomputation, no re-prompting Claude. Cache TTL (24h) is enforced **in code, not the schema** so tuning it later is a config change, not a migration.
- **`migrations/023_alerts_type_check_chat.sql`** (new) — Adds `'chat_flagged'` to the `alerts.type` CHECK constraint. Follows the exact pattern from `011_alerts_type_check.sql`: sanitize any rogue rows first, `DROP CONSTRAINT IF EXISTS`, re-add. Why drop-and-add: Postgres has no `ALTER ... CHECK ... ADD VALUE` for table constraints the way it does for enums.

### Conversational chat — backend

- **`src/services/chatDataContextBuilder.ts`** (new) — Pure data fetcher. Given a `restaurantId`, returns a `ChatContext` shaped for Claude: 28 days of daily revenue/orders, top-15 and bottom-10 items by revenue over 30 days, category breakdown, last 10 alerts — plus a small `meta` object used in the UI to show "Based on 28 days of data, 47 menu items" under each assistant reply. All money stays in cents through this boundary.
- **`src/services/chatPrompt.ts`** (new) — The system prompt + the forced tool. The prompt is **deliberately verbose (>1024 tokens)** — the minimum length for Anthropic's prompt-caching. Subsequent turns pay ~10% of the input cost on the cached prefix. The model is required to call the `answer_question` tool (`tool_choice: { type: 'tool', name: 'answer_question' }`), which guarantees no preamble, no postscript — just the answer string.
- **`src/services/chatService.ts`** (new) — The orchestrator for one user turn: verify conversation ownership (404 on mismatch), load last 8 messages, build data context, send to Claude, persist both user and assistant rows, bump `chat_conversations.updated_at`, return result + usage. A 25-second `AbortController` timeout prevents a hung Anthropic call from holding the request open forever.
- **`src/middleware/chatDailyCap.ts`** (new) — Per-restaurant 50 messages/day. Counts `chat_messages` rows where `role='user'` and `created_at >= today's UTC midnight`. Returns 429 in the project envelope. UTC midnight, not local — the backend may run anywhere and "midnight reset" must be a single global moment.
- **`src/routes/chat.ts`** (new) — Full conversation CRUD + `/usage`. Three load-bearing details: (1) `/usage` registered **before** `/:id` to avoid the parameter route eating it; (2) every handler re-filters by `restaurant_id` resolved from `req.user.sub` on every read/write/delete — the multi-tenant safety is in the WHERE clause; (3) the send handler destructures and renames the service result before responding (see bug story below).

### Purchasing Advisor — backend

- **`src/services/forecastService.ts`** (new) — The pure math. `fetchForecastInputs` returns 56 days of `daily_summaries` + the menu. `buildForecast` is a *pure* function — no I/O. For each menu item: builds a trailing window of `trailingDays` calendar dates (missing days = 0 sold); counts days with actual data (< 14 → `insufficient_history_items`); computes a **linear regression slope** (closed-form, no library); projects next-period demand; clamps projection to ±50% of last-7d actual; derives confidence (low/medium/high at 14/21/28 days) and trend direction (up/down/flat at ±3%).
- **`src/services/forecastNarrativeService.ts`** (new) — Calls Claude with forced `generate_purchasing_narrative` tool: `{ summary: string, callouts: { title, detail }[] }`. Same caching pattern. User message is *just* the JSON forecast items — Claude is never asked to forecast, only to narrate.
- **`src/services/forecastCacheRepo.ts`** (new) — `getFreshForecast(restaurantId, ttlMs)` returns the most recent row within TTL or null. `saveForecast` inserts a new row each refresh (keeps history for cost auditing).
- **`src/routes/advisor.ts`** (new) — `GET /forecast` is a pure cache read — never triggers Claude. `POST /forecast/refresh` runs math + Claude + cache write, rate-limited. If `buildForecast` returns zero items, returns 422 with the 14-day message instead of calling Claude on empty data.

### Chat & Advisor — frontend

- **`src/pages/Chat.tsx`** (new) — Two-column layout: conversation sidebar + message thread. Optimistic send: appends a synthetic user message + the assistant reply to local state immediately on success, rather than refetching the thread.
- **`src/components/chat/MessageThread.tsx`** (new) — Renders bubbles, autoscrolls to bottom. Assistant messages get a "Based on: X days of data, Y menu items" footer from `context_meta`. Three-dot loading indicator with staggered CSS animation delays.
- **`src/components/chat/Composer.tsx`** (new) — Auto-growing textarea (40–120px), Enter to send / Shift+Enter for newline, 2000-char limit with a warning past 1800. Disabled when sending, cap hit, or messages loading.
- **`src/components/chat/DailyCapBanner.tsx`** (new) — Polls `/api/chat/usage` once on mount. Three states: ≥100% (red), ≥80% (amber), else quiet grey.
- **`src/lib/chatApi.ts`** (new) — Typed wrappers for all chat endpoints through `apiFetch`. One `parseBody<T>` helper enforces the `{ data, error }` envelope on every call.
- **`src/pages/Advisor.tsx`** (new) — Calls `GET /forecast` on mount. Refresh button triggers `POST /forecast/refresh`, shows spinner during the slow Claude call. Stale-data banner if `generated_at` > 48h old.
- **`src/components/advisor/ForecastTable.tsx`** (new) — Per-item row: projected (units + dollars), actual last 7d, percent change with icon, confidence badge. Money formatted from cents only at the leaf.
- **`src/components/advisor/NarrativePanel.tsx`** (new) — Claude narrative: summary + numbered callouts. Falls back to skeleton bars during refresh.
- **`src/components/advisor/InsufficientHistoryList.tsx`** (new) — Collapsible "N items don't have enough history yet" with "X days of data (need 14+)" per row.
- **`src/lib/advisorApi.ts`** (new) — Typed `getForecast` / `refreshForecast`, same `parseBody` discipline as `chatApi.ts`.

### Auth (password reset)

- **`src/pages/ForgotPassword.tsx`** (new) — Calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: ${origin}/reset-password })`. Shows "Check your email" on success. Fails silently on unknown emails (Supabase prevents enumeration).
- **`src/pages/ResetPassword.tsx`** (new) — Waits for `PASSWORD_RECOVERY` event from `onAuthStateChange` before unlocking the form — Supabase consumes the recovery token from the URL hash asynchronously.
- **`src/components/auth/AuthShell.tsx`** (modified) — Added `hideTabs?: boolean` prop for recovery pages.
- **`src/components/auth/AuthContext.tsx`** (modified) — Added `resetPasswordForEmail` and `updatePassword` to context.
- **`src/pages/Login.tsx`** (modified) — "Forgot password?" link added.

### App wiring

- **`src/App.tsx`** (modified) — Mounts `/forgot-password`, `/reset-password`, `/chat`, `/advisor`.
- **`src/components/Sidebar.tsx`** (modified) — Two new nav items: AI Chat → `/chat`, Purchasing Advisor → `/advisor`.
- **`src/components/Icons.tsx`** (modified) — Added `chat` and `advisor` icon paths.

### Deployment config

- **`restaurantiq-backend/nixpacks.toml`** (new) — Forces `npm ci` (full install including devDeps), then `npm run build`, then `npm start`. Without this file, Railway's default Nixpacks skips devDeps, `typescript` isn't installed, and the build fails with `tsc: not found`.
- **`restaurantiq-frontend/vercel.json`** (new) — `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`. Without it, Vercel 404s on direct navigations to any route except `/` because Vite builds a SPA — there's no `/chat` file on disk.
- **`.claude/agents/architect-agent.md`** & **`devops-agent.md`** (new) — Codify the architect/devops roles as Claude Code sub-agents. The smoke check globs `.claude/agents/*.md` so new files surface automatically each session.

---

## Key technical decisions

### The forecast math runs in TypeScript; Claude only narrates
**Context.** The lazy path is to dump 28 days of sales into a prompt and ask Claude for projections.
**Decision.** A pure `buildForecast` function does all the math (linear regression slope, moving average, ±50% clamp, confidence tier). Claude is handed the **finished numbers** and asked only to write prose.
**Why.** (1) *Determinism* — same inputs, same numbers, byte for byte. (2) *Cost* — token-priced arithmetic is the most expensive calculator ever built; the math runs in microseconds for free. (3) *Honesty* — we wrote explicit rules for what "confidence: low" means and when we refuse to forecast at all. An LLM is happy to confabulate confidence in a way that hides how thin the sample is. The pure function can be tested with normal unit tests; the LLM never touches a unit count.

### "Last 8 turns" — the chat context window
**Context.** Naïvely sending every message inflates input tokens linearly with conversation length, and the data context blob is already 5–15 KB per turn.
**Decision.** Load only the last 8 messages of the thread.
**Why.** 8 covers ~4 user/assistant pairs — enough for "why?", "compare to last week" follow-ups. Below it, multi-turn breaks. Above it, every turn pays more per message. The system prompt tells Claude to lean on history rather than re-ask. Honest limitation: messages older than 8 turns are invisible to the model. The right fix if this hurts is summarization (compact older turns into one sentence), not "send everything."

### GET /forecast never recomputes; POST /refresh is the only spend trigger
**Context.** If GET could trigger Claude, any page navigation to `/advisor` could silently spend money.
**Decision.** `GET /forecast` is a pure cache read. `POST /forecast/refresh` is the only path that calls Claude, and it's rate-limited.
**Why.** Page-load cost and latency. A button labeled "Generating…" for 12 seconds is a feature; a page that stalls for 12 seconds on paint is a bug. The 24h TTL lives in code, not the schema, so tuning it later is a config change, not a migration.

### The ±50% projection cap
**Context.** Linear regression on 28 days has no sanity check. One viral Saturday produces a slope that extrapolates to "sell 240 burgers next week" when last week was 60.
**Decision.** After computing the raw projection, clamp: `min(max(projection, last_7d_actual × 0.5), last_7d_actual × 1.5)`.
**Why.** Owners use these numbers to order food. Bad-high projection = spoiled inventory. Bad-low = stockout. The clamp acknowledges that last week's actuals are the strongest prior we have. If demand genuinely shifts, the next refresh widens the band because last-7d-actual will be higher. Tradeoff: real demand shocks get smoothed for one cycle. That's the right call.

### 14 days is the minimum to forecast
**Context.** The math will produce a projection from 3 days of data. It will be garbage.
**Decision.** Items with < 14 days in the trailing window go to `insufficient_history_items`. If the entire menu fails, `POST /refresh` returns 422 instead of calling Claude.
**Why.** 14 days captures a full weekly cycle plus one repeat — long enough for day-of-week patterns to register. Below that, we're fitting noise. Telling the owner "we need more history" is more honest than showing confident numbers from 5 data points. And refusing to call Claude on an empty plan saves a wasted API call.

### Forced tool use, not free-form prose
**Decision.** `tools` + `tool_choice: { type: 'tool', name: '…' }` on every Claude call.
**Why.** "Please respond in JSON" prompts fail in interesting ways: markdown fences, preambles, split arrays. The Anthropic tool-use machinery validates output against your `input_schema` server-side. Combined with prompt caching, both features get reliable structure *and* a cost cut on repeat calls.

### Deploy: three small files, one dashboard setting
- `nixpacks.toml`: Railway's default `npm ci` skips devDeps; `typescript` is a devDep; build fails with `tsc: not found`.
- Root directory: the repo's root is the monorepo parent; Railway was building from it (no `start` script) instead of `RestaurantIQ/restaurantiq-backend`.
- `vercel.json` rewrite: Vite produces a SPA; Vercel 404s on direct navigations to `/chat` because that file doesn't exist on disk.
- `VITE_API_URL`: without it set on Vercel, the bundled JS uses the `localhost:3001` fallback baked into `lib/api.ts`.

### Bug fixed post-deploy: white screen after three dots
**Symptom.** User types a question, sees loading indicator, page goes white.
**Diagnosis.** `chatService.ts` returned `{ assistantMessage, usage }`. The route passed it directly as `data`. Frontend expected `{ message, usage }`. `message` was `undefined`. `undefined` pushed into the messages array. `MessageThread` crashed on `msg.role`.
**Fix.** Route now destructures and renames: `const { assistantMessage, usage } = ...; res.json({ data: { message: assistantMessage, usage } })`.
**Lesson.** Service-internal types and API contract types should be separately named with an explicit translation at the route boundary. Returning service results directly couples the wire format to whatever the implementer named a variable.

---

## Patterns and concepts you used

- **Forced tool use as schema enforcement** — Anthropic's tool-use protocol turns "please respond in JSON" (unreliable) into "output validated against this schema or the call fails" (reliable). Same idea as runtime contracts in Zod, but enforced between services.
- **Prompt caching** — >1024-token system prompt marked `cache_control: ephemeral` is cached for ~5 minutes; subsequent calls pay ~10% of input cost on the cached prefix. The "intentionally verbose" comments are doing real work.
- **Functional Core, Imperative Shell** — `buildForecast` (pure, testable) / `fetchForecastInputs` + `generateForecastNarrative` (impure). The pure core / impure shell pattern: testability and determinism where it pays off without forcing a paradigm shift on the I/O layer.
- **CQRS in miniature** — `GET /forecast` (read, cheap, never spends) vs `POST /forecast/refresh` (write, expensive, rate-limited). Different routes, different concerns, shared storage.
- **Denormalization for tenancy** — `chat_messages.restaurant_id` is redundant with `chat_conversations.restaurant_id`, but it lets the daily-cap count be one-table and one-index. Storage is cheap; joins on the hot path aren't.
- **API contract translation at the seam** — the white-screen bug was the cost of skipping this. Service-internal names and wire names are separate; the route translates between them. The fix wasn't "be more careful," it was "add a rename."
- **Optimistic UI with idempotent replacement** — chat appends a synthetic user message + assistant reply on success instead of refetching the thread. Trades a tiny race risk against snappy feel.

---

## What you should be able to explain in an interview

**Q: Your advisor page does a forecast. Why did you write the statistics in TypeScript instead of asking the LLM to project the numbers?**
Three reasons. Determinism — same inputs, same numbers, always; LLMs give different prose on every call but I never want different *units*. Cost — token-priced arithmetic is the most expensive calculator ever built, and I'm paying every refresh. And honesty — I wrote explicit rules for what "low confidence" means and when we refuse to forecast at all. An LLM is happy to confabulate confidence in a way that hides how thin the sample is. So the function does the math — linear regression slope on a moving-average baseline, clamped ±50% — and Claude only writes the narrative on finished numbers. The pure function is testable with normal unit tests.

**Q: You cap chat context at 8 turns. How did you pick that, and what breaks?**
8 is ~4 user/assistant pairs, enough for the follow-ups owners actually do ("why?", "compare to last week"). Below it, multi-turn breaks. Above it, cost scales linearly with conversation length, on top of a 5–15 KB data context blob I'm already attaching per turn. The model is told to lean on recent history rather than re-ask for context. Honest limitation: messages older than 8 turns are invisible to it. The right fix when that hurts is summarization — compact older turns into one sentence — not sending everything.

**Q: Why does the forecast refuse to project items with fewer than 14 days of history?**
14 days captures a full weekly cycle plus a second repeat — long enough for day-of-week patterns to register and for a slope estimate to be more than fitting noise. Below that I'm projecting from random points. Owners use these numbers to order food; a confident "sell 60 next week" from 5 data points would be worse than saying nothing. So I exclude under-14-days items and surface them separately with "X days of data (need 14+)". Above 14, I tier confidence — low/medium/high at 14/21/28 — so the user has a calibrated read on how much to trust each row.

**Q: Your projections are clamped to ±50% of last week's actuals. Why?**
Naive linear regression on 28 days has no sanity check. One viral Saturday plus a normal Sunday produces a slope that extrapolates to "sell 240 burgers next week" when last week was 60. Owners use these numbers for food orders; a bad-high projection is spoiled inventory, a bad-low is a stockout. The clamp acknowledges that last week's actuals are the strongest prior we have. If demand really does shift, next week's refresh widens the band because last-7d-actual will be higher. The tradeoff: real shocks get smoothed for one cycle. That's the right call — the worst failure mode of an unbounded projection is far more expensive than a one-cycle lag.

**Q: First deploy — what did you have to learn the hard way?**
Three small files and one dashboard setting. Railway's Nixpacks defaults skip devDeps on install; `typescript` is a devDep, so `tsc: not found` and the build fails — fixed with a `nixpacks.toml` that explicitly says "run `npm ci` then build." The Railway root directory had to point at `RestaurantIQ/restaurantiq-backend`, not the monorepo root. A Vercel SPA needs a rewrite rule so direct navigations to `/chat` don't 404 — Vercel looks for a file at that path, finds none, serves 404; the rewrite says "serve `index.html` for any path and let React Router decide." And `VITE_API_URL` had to be set on Vercel pointing at the Railway URL; otherwise the bundled JS used the `localhost:3001` fallback and every API call failed in production.

**Q: You shipped a bug — white screen after the loading indicator. What was it?**
Mismatched property names across a service-to-route-to-frontend boundary. The chat service returned `{ assistantMessage, usage }`. The route passed that object directly as the response `data`. The frontend expected `{ message, usage }` — same shape as every other endpoint. `message` was `undefined`, it got pushed into the messages array, and the renderer crashed trying to read `.role` off `undefined`. Fix was a one-liner rename at the route boundary. The lesson: service-internal types and wire format types should have separate names with an explicit translation step. Returning service results directly couples the API to whatever the implementer happened to name a variable that day.

---

## What to look up if you want to go deeper

- **Anthropic tool use and prompt caching** — `docs.anthropic.com`. The 1024-token minimum for caching and the ~10% cached-input price ratio are documented there.
- **Forecasting fundamentals** — Hyndman & Athanasopoulos, *Forecasting: Principles and Practice* (free online). Chapters on moving averages, trend extrapolation, and ETS cover what `buildForecast` does and what it doesn't (seasonal decomposition). If weekly seasonality matters: ETS/ARIMA.
- **Functional Core, Imperative Shell** — Gary Bernhardt's 2012 talk by that name. The `buildForecast` (pure) / `fetchForecastInputs` (impure) split is exactly this pattern.
- **CQRS** — Martin Fowler's CQRS write-up. The `GET /forecast` / `POST /forecast/refresh` asymmetry is CQRS in miniature.
- **SPA routing and the rewrite problem** — the Vercel docs on `rewrites`, the React Router "deploying" guide. Same fix on Netlify (`_redirects`); understanding *why* (the server doesn't know your client-side routes) is the point.
- **Nixpacks** — `nixpacks.com/docs/configuration/file`. The four-phase model (setup/install/build/start) explains why Railway's default bit us.
- **Supabase auth recovery flow** — the Supabase docs page on "Resetting passwords." The async `PASSWORD_RECOVERY` event from `onAuthStateChange` is the non-obvious piece `ResetPassword.tsx` depends on.
- **`AbortController` in Node** — MDN, then look at how the Anthropic SDK accepts `{ signal }` as a second arg to `messages.create`. This is how both `chatService` and `forecastNarrativeService` enforce their 25s cap.

---

## Things you punted (named technical debt)

- **No tests on `buildForecast`** — the most testable code in the sprint (pure function, deterministic, finite input space) shipped without unit tests. Worth adding: the 14-day cutoff, ±50% clamp, confidence tiers, empty-window case. Highest-leverage test debt in the codebase right now.
- **Chat history is unbounded** — the table grows forever. The daily-cap `COUNT(*)` hits the `(restaurant_id, role, created_at DESC)` index efficiently today but will slow down at scale. Add soft archival after 90 days or paginate the message list.
- **No data-context cache for chat** — every turn re-runs `buildChatContext` (4 Supabase queries). The data only changes after a POS sync. A ~5-minute per-restaurant memoization (or invalidation on sync) would cut the read cost meaningfully.
- **Forecast cache grows forever** — each refresh inserts a new row. Add a retention policy (`DELETE WHERE generated_at < now() - interval '30 days'`).
- **`chat_flagged` alert type exists but nothing emits it** — migration 023 added the value; `chatService.ts` never writes an alert. Decide if this is a Sprint Q feature or revert.
- **No streaming chat responses** — users stare at three dots for 4–8 seconds. Anthropic supports streaming; the frontend has the loading-state plumbing. Streaming is the next perceived-perf win.
- **Daily cap is per-restaurant, not per-user** — shared across all staff at a restaurant. Fine for solo owners; revisit when multi-user lands.
- **`createAiRateLimiter()` is still in-memory** — inherited from Sprint N. The chat daily cap is DB-backed (correct across instances), but the short-window AI rate limiter is per-process. Together: correct floor, leaky ceiling until Redis lands.
- **±50% clamp is symmetric and global** — a new menu item ramping fast, or a holiday week slowing down, both hit the cap. A per-category or per-item override would be more correct.
