# Week 1 — AI Insights backend layer (Claude Haiku + auth-scoped /api/insights)

## Sprint goal in one sentence

Wire up a single backend endpoint that pulls a restaurant's last 30 days of pre-aggregated daily sales, hands them to Claude Haiku, and returns 5–8 prioritized, structured insights — cheaply, reliably, and only for the authenticated owner.

## What shipped, in plain English

- A new `GET /api/insights` route that an authenticated user can hit from the dashboard. It looks up *their* restaurant from the JWT, pulls the last 30 days of daily summaries, and returns a list of prioritized recommendations.
- A first integration with Claude — specifically the Haiku model — that returns insights as structured JSON, not free text, so the frontend can render them without parsing prose.
- Prompt caching wired up so the long system prompt (the "what an insight should look like" instructions) isn't re-billed on every request.
- A graceful empty state: if the restaurant has fewer than 3 days of data, the API returns a single "not enough data yet" insight instead of paying Anthropic for nothing.
- A documented database migration (`003_daily_summaries_menu_item_fk.sql`) that pins down the foreign key the insights query relies on, so a fresh Supabase rebuild won't silently break it.
- A real end-to-end auth lesson: we proved the chain *frontend JWT → backend middleware → user-scoped DB lookup → Claude → response* works, then hit a "credit balance too low" 400 from Anthropic — which means every other layer was correct on the first try.

## File-by-file

### NEW — `restaurantiq-backend/src/services/anthropicService.ts`

Thin service wrapper around the Anthropic SDK. Three jobs: build the request, validate the response shape, and degrade gracefully.

- Defines two TypeScript interfaces (`SummaryRow`, `Insight`) that the route and the SDK call agree on. `SummaryRow` includes the embedded `menu_items` object that PostgREST returns from a join.
- Declares `INSIGHTS_TOOL` — a JSON-Schema tool definition (`name: 'report_insights'`, array of 5–8 insight objects, each with a fixed enum of categories). This is the contract Claude *must* satisfy.
- Holds a deliberately verbose `SYSTEM_PROMPT` (~1,300 tokens). The verbosity is not for the model's benefit — it's to clear Haiku's 1,024-token cacheable-prefix minimum. See decisions below.
- `generateInsights(summaries)` is the only export. Lazy-instantiates the Anthropic client *inside* the function (so `dotenv` has already populated `process.env.ANTHROPIC_API_KEY` by then), wires up a 25-second `AbortController` timeout, sends the request with `tool_choice` forced to `report_insights`, and pulls the input out of the `tool_use` block.
- Two failure modes are handled distinctly: `<3` rows returns a hard-coded `FALLBACK` (no API call); any thrown error is logged with `APIError` discrimination and re-thrown so the route can map it to a 502.

### NEW — `restaurantiq-backend/src/routes/insights.ts`

The HTTP surface. About 50 lines because most of the heavy lifting belongs in the service.

- Mounts `authMiddleware` on the router, so every request is JWT-verified before the handler runs.
- Reads `req.user.sub` (the Supabase user UUID) and looks up the restaurant by `user_id`. This is the *only* tenant-scoping mechanism — there is no RLS on the table, so this line is what stops cross-tenant leakage.
- Builds a `since` date 30 days back, formats it as `YYYY-MM-DD`, and queries `daily_summaries` with the PostgREST embed syntax `menu_items(name, category)`. PostgREST is the auto-generated REST layer Supabase exposes on top of Postgres; the embed syntax turns FK relationships into a join you can request from the client.
- Calls `generateInsights`, returns `{ data, error }` on success, or `502` with a friendly error string when Anthropic throws.

### NEW — `restaurantiq-backend/migrations/003_daily_summaries_menu_item_fk.sql`

Idempotent SQL file documenting the FK from `daily_summaries.menu_item_id` to `menu_items.id` with `ON DELETE SET NULL`. Wraps the `ALTER TABLE` inside a `DO $$ ... $$` block guarded by an `information_schema.table_constraints` check, because the constraint was created live in the Supabase dashboard before any of us thought to write a migration. This file is documentation that survives a sandbox rebuild — it adds the constraint if missing, and is a no-op if it's already there.

### MODIFIED — `restaurantiq-backend/src/server.ts`

One line of plumbing: `app.use('/api/insights', insightsRouter)`. The router is auth-scoped internally, so `server.ts` doesn't need to know about middleware ordering for this route.

### MODIFIED — `restaurantiq-backend/package.json` and `.env.example`

- `package.json`: added `@anthropic-ai/sdk` as a runtime dependency.
- `.env.example`: added `ANTHROPIC_API_KEY=` and `ANTHROPIC_MODEL=claude-haiku-4-5-20251001`. The model is read with `process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'` so you can flip Haiku ↔ Sonnet from `.env` without a code change.

## Key technical decisions

### 1. Tool use for structured output, not "respond as JSON"

**Context.** The frontend needs an array of insights with a fixed enum of categories. We had two options: prompt the model ("respond with valid JSON, here's a schema") and `JSON.parse` the text, or use the Anthropic SDK's tool-use feature with `tool_choice: { type: 'tool', name: 'report_insights' }`.

**Decision.** Tool use, with `tool_choice` forced.

**Why.** Forcing a tool call binds the response to a real JSON Schema that the API enforces — `enum` values, `minItems`/`maxItems`, `required` fields. Prompting "please return JSON" gets you "Sure! Here's the JSON: ```json {...}```" maybe 95% of the time and a 3 a.m. parse error the rest. Tool use moves validation from your code into the API boundary, which is the correct place for a contract.

**Subtle bug we'd have hit.** If we'd prompted for JSON, the first time Claude included a `category` outside our enum (and it would, because LLMs love to invent new categories), the frontend's switch statement would silently fall through to `default` and render a blank card. Tool-use schema validation refuses to emit that response in the first place.

### 2. Ephemeral prompt caching, with the system prompt deliberately padded

**Context.** Every request sends ~1,300 tokens of "what makes a good insight" boilerplate, then a small dynamic body of summaries. Re-billing the boilerplate is wasteful.

**Decision.** Mark the system block with `cache_control: { type: 'ephemeral' }` and accept that the prompt has to be at least 1,024 tokens for Haiku to cache it.

**Why.** Anthropic's prompt cache only kicks in above a per-model minimum cacheable prefix length. For Haiku, that's 1,024 tokens. Below the threshold the `cache_control` annotation is silently ignored — you pay full freight. We chose to write the system prompt *to* the threshold rather than under it, because the long version genuinely produces better insights (it teaches the model what "actionable" looks like with examples) *and* it's free after the first call. So the verbosity has two payoffs, not one.

**Subtle thing.** Ephemeral cache TTL is ~5 minutes. That fits this workload — a dashboard user pokes around, refreshes a few times, and the cache pays for itself within the session. If we ever batch this nightly across all restaurants, we'd want to think about the cache *miss* path being the common case again.

### 3. Lazy Anthropic client instantiation

**Context.** The obvious shape is `const client = new Anthropic()` at the top of the file. We do it inside `generateInsights` instead.

**Decision.** Construct the SDK client per-call (it's cheap — no network, just object construction).

**Why.** Module-load order in Node bites you here. If `anthropicService.ts` is `import`-ed transitively before `dotenv.config()` runs in `server.ts`, the SDK constructor reads `process.env.ANTHROPIC_API_KEY` as `undefined` and throws. Lazy construction sidesteps the entire ordering problem. The cost is negligible because the SDK is stateless across calls.

### 4. 25-second AbortController timeout

**Context.** Express has no built-in request timeout. A hung Anthropic request would hold the connection open until the load balancer killed it.

**Decision.** Wrap the SDK call in an `AbortController`, abort at 25s, clear the timer in `finally`.

**Why.** The SDK respects `signal`, and 25s is shorter than typical proxy timeouts (usually 30s) so we surface a clean 502 to the client instead of an opaque socket hang-up. The `finally` block matters: if the call returns in 2s, the timer must be cleared or the Node process keeps a dangling handle.

### 5. `<3` rows fallback before the API call

**Context.** A new restaurant connects Square, syncs, and immediately clicks "Insights". They have one day of data. Asking Claude to generate 5–8 cross-week trend insights from one row is both expensive and useless — it will hallucinate.

**Decision.** Hard-code a single-element fallback for `summaries.length < 3` and return it without touching Anthropic.

**Why.** Cheaper, faster, and produces honest output ("not enough data yet — keep recording sales") instead of confabulated trends. The threshold is 3 because that's the minimum where week-over-week language stops being a lie.

### 6. PostgREST embeds are arrays, even for many-to-one — caught by typecheck, not by us

**Context.** The insights query uses PostgREST's embed syntax: `select('*, menu_items(name, category)')`. The FK on `daily_summaries.menu_item_id` is many-to-one (each summary points to one menu item), so it's intuitive to type the embedded field as `{ name: string; category: string } | null` and write `s.menu_items?.name`. That's what shipped to staging.

**Decision.** Type `menu_items` as `{ name: string; category: string }[] | null`, unwrap with `[0]` at the read site, and never assume PostgREST will collapse a single-row embed into an object.

**Why.** PostgREST serializes *every* embedded relation as an array regardless of cardinality — the API doesn't look at the FK direction when shaping the response. `npx tsc --noEmit` flagged this at `src/routes/insights.ts:45` after the vertical was wired up; without that typecheck pass, every `s.menu_items?.name` would have evaluated to `undefined`, the route would have substituted the `'Unknown'` fallback, and every row Claude saw would have had `menu_item_name: "Unknown"`. The `menu_performance` category — the most concrete, most useful one — would have produced nothing but generic advice. The bug would have been invisible in logs (no error, just bad insights) and only catchable by a human reading the output and going "wait, why doesn't it ever name an item?"

**Why this is a teaching moment.** This is the *second* PostgREST-embed-shape bug in this codebase. The first was the silent `[]` return when the FK isn't declared in the schema (which is exactly why we wrote migration 003 at the top of this same sprint). Two bugs, same library, same root cause: assuming the embed shape instead of inspecting it. The QA agent's bug-catalog convention exists for exactly this — if a class of bug has bitten us twice, it goes in the catalog and every future PR touching that surface gets checked against it. Going forward, the rule is: any PostgREST embed read gets a runtime shape assertion (or at minimum, the TypeScript types are derived from a real fixture response, not hand-written from intuition).

**Subtle thing.** TypeScript caught this only because we run `tsc --noEmit` in CI. If we'd been relying on `ts-node`'s loose mode or skipping typecheck entirely, the runtime would have happily returned `undefined` from `s.menu_items?.name` and the bug ships. The typecheck step is doing real work — it's not just ceremony.

### 7. Migration 003 idempotent because the FK already existed in production

**Context.** During QA, the QA agent flagged that the insights query relied on a FK that wasn't in any migration file. A SQL probe against the live Supabase confirmed the constraint *was* there — somebody (you, in the dashboard) had added it days earlier.

**Decision.** Write `003_daily_summaries_menu_item_fk.sql` as a `DO $$` block that checks `information_schema.table_constraints` first.

**Why.** The migration is now documentation: a fresh checkout that runs all migrations against an empty database gets the constraint, and the existing live DB is a no-op. The alternative — skipping the migration because "it's already there" — leaves the codebase unable to reproduce its own schema. That's the kind of debt you only notice when a new dev tries to set up locally.

## Patterns and concepts you used

- **Function calling / tool use as schema enforcement.** Treating an LLM tool definition as a typed RPC boundary. Mechanically: the API rejects model outputs that don't match the schema before they reach your code. Conceptually: same idea as a Protocol Buffers message — define the shape once, let the runtime enforce it.
- **Prompt caching as a content-addressed prefix cache.** The cache key is essentially a hash of the prefix tokens. Anything before the first non-cached block is reusable across calls; anything after invalidates per call. Hence the discipline of putting *static* content (system prompt, tool defs) before *dynamic* content (user data).
- **Lazy initialization to dodge module-load ordering.** Classic deferred construction — same pattern as singleton-with-getter or React's `useMemo`. The fix is always "don't read the value until you need it."
- **AbortController for timeouts.** Web-platform standard, now native in Node. Same primitive that powers `fetch` cancellation in the browser.
- **Pre-aggregation for read-side speed.** `daily_summaries` is computed at write-time after each Square sync; the insights endpoint reads from it instead of `SUM(...) GROUP BY` over `order_items`. Tradeoff is staleness vs latency; we picked latency.
- **JWT `sub` claim as the single source of tenancy.** Every protected route does the same thing: read `req.user.sub`, find the restaurant where `user_id = sub`, scope all subsequent queries by `restaurant.id`. RLS would push this into the database; we push it into the controller.
- **Idempotent migrations.** The `DO $$ ... IF NOT EXISTS` pattern is the SQL equivalent of `mkdir -p`. Worth doing reflexively for any DDL.

## What you should be able to explain in an interview

**1. What's the difference between a Supabase anon key and a user session JWT?**

Both are JWTs, both go in an `Authorization: Bearer …` header, but they answer different questions. The anon key (and the service-role key) are *static API keys* baked into your project — they identify your app to Supabase and tell PostgREST "this request is allowed to hit the database under such-and-such role." They do not represent a user. Crucially, they have no `sub` claim, so any backend that derives user identity from `sub` will reject them.

A user session JWT is what Supabase Auth issues after a successful sign-in — `signInWithPassword`, magic link, OAuth, whatever. It has a `sub` claim equal to the user's UUID, an `aud` of `authenticated`, and an `exp` that's typically an hour out. *That's* the token your protected backend routes want. The mental model that helped me: anon key authorizes the *application*, the session JWT authorizes the *person*. I learned this the hard way today — I sent the service-role key first and got "Invalid token", then the anon key and got "Missing user id on token" — which was the middleware correctly telling me there was no `sub` to scope by.

**2. Why force tool use for structured output instead of asking the model for JSON?**

Two reasons, one practical and one philosophical. Practically: tool use makes the API enforce a JSON Schema before the response leaves Anthropic. If I declare `category` as an enum of seven values and the model wants to invent an eighth, the API regenerates instead of returning broken JSON to my code. With "please respond as JSON" I'd be parsing markdown-fenced text and praying the enum holds.

Philosophically: I want my LLM call to behave like an RPC, not like a chat. An RPC has a typed contract on both sides. Tool use is the closest thing the API gives me to that. The bonus is that my TypeScript `Insight` interface and the JSON Schema I send to Anthropic describe the same shape — if I ever wire up a code-gen step they could be the same artifact.

**3. How does prompt caching actually save you money, and why is the system prompt verbose on purpose?**

The cache works on prefixes. You mark a block with `cache_control: ephemeral`, and on the second request within ~5 minutes, the tokens up to that point are billed at roughly a tenth the rate. So I want my static, expensive content — the long "here's what a good insight looks like" instructions and the tool schema — at the *front* of the request, and the dynamic body at the back.

The catch with Haiku is there's a 1,024-token minimum cacheable prefix. Below that, the cache flag is a no-op. So I deliberately wrote a system prompt long enough to cross that line — about 1,300 tokens. Two payoffs: the longer prompt actually produces better insights because it teaches by example, and it's free on subsequent calls within the cache window. If I'd written a 600-token prompt I'd be paying full price every time and getting worse output for it.

**4. Why is the Anthropic client constructed inside the function instead of at the top of the module?**

Module-load ordering. If anything imports my service file before `dotenv.config()` runs in `server.ts`, the SDK constructor reads `process.env.ANTHROPIC_API_KEY` as undefined and throws at import time. That's an annoying class of bug because it doesn't show up until the import graph changes. By constructing inside `generateInsights`, the env var is read when the function runs, by which point Express is up and `dotenv` definitely fired. The SDK client is cheap to construct, so there's no real cost — and even if there were, I'd rather pay it than debug a load-order Heisenbug.

**5. How does multi-tenancy work in this app right now, and what's the failure mode you're watching for?**

The only thing tying a row to a tenant is `restaurants.user_id` matching `req.user.sub`. RLS — Postgres row-level security — is bypassed because the backend uses the Supabase service-role key. So tenant isolation is enforced *in code*, in every controller, by deriving `restaurantId` from the authenticated user before any other query.

The failure mode I'm watching: any new endpoint that takes `restaurantId` as a query parameter without validating it against the JWT. Today's insights route does it correctly — it never trusts a client-supplied id, it looks up the restaurant by `user_id`. But the day someone writes `GET /api/orders?restaurantId=X` and forgets to verify ownership, that's the cross-tenant leak. The longer-term fix is to turn RLS back on and let Postgres enforce it, but for an MVP with one tenant this is fine and faster to iterate on.

**6. The end-to-end test got a 400 from Anthropic about credit balance. Why is that actually good news?**

Because it means everything *I* wrote was correct on the first run. The request reached Anthropic with a valid API key, the JSON body parsed, the tool was registered, the JWT verified, the database query worked, the embed join returned the right shape, the auth middleware extracted `sub`, the restaurant lookup found my row. The only thing that failed was the bank account behind the API key. That's the cleanest failure you can get on a first integration — it tells you the plumbing is right and the only remaining task is to top up.

## What to look up if you want to go deeper

- **Anthropic tool use docs** — `https://docs.anthropic.com/en/docs/build-with-claude/tool-use` — especially the "forcing tool use" and "JSON mode vs tool use" sections.
- **Anthropic prompt caching docs** — `https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching` — pay attention to the per-model minimum prefix length table; that's the gotcha.
- **PostgREST embedding docs** — `https://postgrest.org/en/stable/references/api/resource_embedding.html` — specifically the part where the FK is what makes the embed syntax legal.
- **`jose` library source** — `https://github.com/panva/jose` — the `createRemoteJWKSet` function is small enough to read end-to-end and will demystify how JWKS rotation works.
- **JWT, JWS, JWK RFCs** — RFC 7519 (JWT), RFC 7515 (JWS), RFC 7517 (JWK). Read 7519 first; the others fill in mechanics.
- **"Designing Data-Intensive Applications" by Martin Kleppmann** — Chapter 11 (stream processing) frames the pre-aggregation pattern in `daily_summaries` as a materialized view.
- **`AbortController` on MDN** — short read, web-platform-native, same primitive in Node and browser.
- **Supabase Auth deep dive** — `https://supabase.com/docs/guides/auth/sessions` — the difference between API keys and session tokens is documented but easy to skim past.

## Things you punted

- **`restaurants.user_id` is not set by the seed script.** After signing up for a real auth user today, I had to manually `UPDATE restaurants SET user_id = '<uuid>' WHERE id = '<seed-id>'` to make the insights endpoint find the row. Either the seed should accept a `user_id`, or the signup flow should create a restaurant for the new user. Right now there's a silent mismatch between fixture data and live auth.
- **No retry on Anthropic 5xx / 429.** A single transient failure becomes a 502 to the user. Anthropic publishes recommended retry policies (exponential backoff with jitter, only on 429/500/502/503/504) — wire those up before this hits real traffic.
- **No rate limiting on `/api/insights`.** Hitting refresh ten times in a row triggers ten Haiku calls. After the first one the prompt cache absorbs the system-prompt cost, but the dynamic body is still billed each time. A simple per-user/per-minute limiter (or a 60-second response cache keyed on `restaurant.id`) would knock that out.
- **No tests.** Not even a snapshot of the insights schema. The tool definition is the contract — a single test that calls `generateInsights` against a fixture summary array and asserts the shape would catch regressions cheaply.
- **`menu_items` returned as `null` is silently passed through.** When the FK can't resolve (item was deleted, or the row predates the FK), we send `'Unknown'` to Claude. That's a data-quality issue that will show up as garbage insights eventually. Worth tracking how often it happens before deciding whether to filter or backfill.
- **PostgREST embed reads aren't wrapped in a runtime shape assertion.** We fixed the `menu_items(name, category)` array-vs-object bug in `insights.ts` once typecheck flagged it, but nothing stops the next embed query from making the same mistake — or from drifting if PostgREST ever changes its serialization. The right move is a tiny helper (`unwrapEmbed(row.menu_items)` that asserts array-shape and returns the first element, or `null`) used at every embed read site. Until that exists, this is a flagged risk: any future endpoint that does `select('*, foo(...)')` and reads `row.foo.something` is a latent bug. The QA agent's bug catalog should have an entry for this so it's checked on every PR that touches a Supabase query.
- **Migration 003 is documentation, not enforcement.** Nothing prevents the next dev from making a schema change in the dashboard without writing a migration. The real fix is `supabase db diff` or pulling Atlas/Sqitch in — not today's problem, but eventually somebody's.
- **`ANTHROPIC_MODEL` is a string env var with no validation.** Set it to a typo and you get a runtime 404 from the API instead of a startup failure. A Zod schema on env at boot is cheap insurance.
