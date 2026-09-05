# Sharp Edges — canonical catalog

The single source of truth for pitfalls this codebase has already hit. Every agent
(architect, backend, frontend, QA, teaching) reads this before working; when a new
pattern-level bug is found, add it **here** (and the full war story to [`bugs.md`](bugs.md))
rather than to an agent definition. Agent files must point here, not copy from here.

## Environment & config

- **Env vars are read lazily.** `dotenv.config()` runs in `server.ts` *after* imports, so
  `process.env.X` at module load time is `undefined`. Read env vars inside functions.
  (Hit with the JWKS URL — see `restaurantiq-backend/src/middleware/auth.ts`.)
- **Frontend env vars** must be prefixed `VITE_` and declared in `src/vite-env.d.ts`,
  or Vite won't expose them / TypeScript won't compile.
- **Vite proxy**: dev-server `/api/*` calls fail unless `vite.config.ts` proxies to `:3001`.
- **Observability SDKs capture credentials by default.** Anything that auto-attaches
  request context (Sentry and friends) will ship the onboarding request body —
  which carries a Square access token — plus the `Authorization` header, to a
  third party. Strip structurally (drop the body, allowlist headers) *and*
  pattern-scrub the event; predicting every field that could hold a secret does
  not work. See `src/config/sentryScrub.ts`.

## Supabase / PostgREST

- **Embed shape depends on cardinality.** A to-one (many-to-one) embed returns an **object**;
  a to-many embed returns an **array**. Don't unwrap to-one embeds with `[0]` — the access
  silently yields `undefined` and `??` fallbacks mask it (bug #17; supersedes bug #4's
  "always arrays" lesson). Never hand-write the TypeScript type for an embed — derive it
  from a real fixture response.
- **Embeds require real FK constraints**, not just matching column names. Missing FK →
  embed silently returns empty. Verify the FK exists or use a two-step fetch
  (parent rows → children via `.in('parent_id', ids)`). (Migration 007 + the
  `ingestSquare.ts` rewrite.)
- **`upsert` + partial unique indexes don't mix.** `onConflict: 'a,b,c'` translates to
  `ON CONFLICT (a,b,c)` without the `WHERE` predicate. Use a regular `UNIQUE` constraint.
  (Migration 008.)
- **Two Supabase clients exist**: `db.ts` (canonical) and a legacy one in `server.ts`
  (used only by `restaurantController.ts`). New code uses `db.ts`. Never add a third.

## Schema & migrations

- **CHECK constraint gaps.** Adding a new value to an enum-style column (`source`, `type`)
  requires migrating the CHECK, named explicitly. Hit twice (`menu_items.source`,
  `orders.source`).
- **Migrations go through the tracked runner and must be idempotent where practical**
  (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ADD`). Number each file and apply it
  with `npm run migrate`; never hand-paste production changes into the SQL editor.

## Async & scheduling

- **`Promise.race` does not cancel the loser.** A timeout race rejects the caller,
  but the work it raced against keeps running: the losing timer stays armed, and a
  losing loop keeps calling the provider after its job was already recorded as
  failed and a retry started a second pull. Clear the timer in `finally`, and give
  any unbounded loop inside a raced promise its own bound so it stops itself.
  (`syncIntegration`'s 90s race in `syncScheduler.ts`, and the page cap plus
  deadline in `services/square/paginate.ts`.)
- **A batch cap over an unordered query starves the tail.** `slice(0, limit)` on a
  `select()` with no `ORDER BY` is not "the first N this round", it is the same N
  every round, and everything past the cap simply never runs. Order by whatever
  makes the selection rotate (least-recently-attempted) and log when the batch is
  truncated, so growth past the cap shows up in logs instead of as missing data.
  (`prioritizeByStaleness` and `SCHEDULER_BATCH_TRUNCATED` in
  `services/scheduler/index.ts`.)
- **A partial pull that reports success is worse than a failed one.** Swallowing a
  paging error and continuing records a green sync over silently incomplete data.
  Throw and let the retry budget handle it. Check that the thrown message cannot
  match `isAuthError` in `syncScheduler.ts`, or a transient failure gets
  classified as permanent and never retries.

## Square

- **SDK v37 mishandles `undefined` positional args** — produces malformed URLs with `&&&&`.
  Use the object-form call or pass only required args.
- **Line items reference catalog *variation* IDs**, not item IDs. `menu_items.external_id`
  must store the variation ID or order linkage breaks silently.

## React / frontend

- **A stock-photo license does not clear embedded third-party rights.** Before using an
  image in commercial marketing, inspect the final crop for venue names, trademarks,
  recognizable artwork, and identifiable people. Avoid visuals that could imply an
  endorsement even when the image itself is free to use (bug #18 in `bugs.md`).
- **StrictMode double-runs effects** in dev. Every async `useEffect` needs a `cancelled`
  flag checked before `setState`, cleared in cleanup.
- **Stale closures in contexts.** `useCallback`/`useEffect` deps must include `session`
  (or whatever is read from another context), or sign-out leaves stale data.
- **Auth tokens come from `session.access_token`.** `user.getIdToken()` is Firebase API —
  it doesn't exist on Supabase users.
- **Tailwind JIT tree-shakes dynamic class names.** Never build class strings at runtime
  (`bg-${color}-100`); use complete literal class names.
- **`<Navigate>` redirects during render**, before any effect (even `useLayoutEffect`)
  fires. Guarding against a flash of the wrong route must happen during the parent's
  render pass (bug #1 in `bugs.md`).

Full diagnoses and false starts: [`bugs.md`](bugs.md).
