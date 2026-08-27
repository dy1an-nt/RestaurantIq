# Sprint K — DoorDash Trust & Hardening: Findings Report

**Goal:** Make the DoorDash revenue channel production-trustworthy and prove it
behaves correctly under re-sync. **No new features** — validation, hardening,
and correctness only.

**Status:** Test coverage parity achieved; persistence layer now tested directly;
idempotency proven; response-shape assumptions locked behind tests. Two goals
(live API shape capture, live DB sync) are **partially blocked by missing DoorDash
credentials** and were addressed via faithful offline equivalents — documented
honestly below rather than faked.

---

## 1. What was delivered

### New automated tests (66 tests across 5 suites)

| Suite | File | Tests | What it locks down |
|-------|------|------:|--------------------|
| DoorDash client | `services/doordash/__tests__/doordashClient.test.ts` | 21 | mock-mode determinism, live response-shape parsing (`json.items`/`json.data`, `json.orders`/`json.data`), credential guards, non-OK error handling, `refreshAccessToken` (success / mock / no-token / missing-creds / non-OK / missing-token / network error) |
| Normalizers | `services/doordash/__tests__/normalizers.test.ts` | 12 | catalog + order field mapping, `source='doordash'` tagging, total-fallback-to-line-sum, missing-field defaults, null guards |
| Token refresh | `services/doordash/__tests__/ensureFreshToken.test.ts` | 7 | proactive refresh, 60s skew window, persist-new-token, fallback-on-refresh-failure, persist-failure resilience |
| Ingestion flow | `services/doordash/__tests__/ingestDoorDash.test.ts` | 7 | full pipeline → DB records, source tagging, order/item linkage, revenue reconciliation, **idempotency** |
| Shared persistence | `services/ingestion/__tests__/persistence.test.ts` | 19 | order dedup, restaurant + order-item linkage, summary aggregation/update/prune, cross-source isolation, idempotent writes, legacy no-`external_id` fallback, alert isolation |

Plus a reusable in-memory Supabase fake: `services/ingestion/__tests__/fakeSupabase.ts`.

### Coverage summary (target files)

```
File                | % Stmts | % Branch | % Funcs | % Lines | Uncovered
--------------------|---------|----------|---------|---------|-----------
doordashClient.ts   |   98.55 |    87.87 |    92.3 |     100 | —
ingestDoorDash.ts   |   94.44 |    71.42 |     100 |   97.82 | 98
normalizers.ts      |     100 |      100 |     100 |     100 | —
persistence.ts      |   88.31 |    59.01 |   94.44 |   96.63 | 309,312-317
--------------------|---------|----------|---------|---------|-----------
All target files    |   92.59 |    73.88 |   94.87 |   97.87 |
```

Full backend suite: **9 suites / 95 tests, all passing** (was 8 / 86 before Sprint K).

Remaining uncovered lines are non-critical logging branches:
`ingestDoorDash.ts:98` (live-mode missing-store guard, unreachable in mock mode)
and `persistence.ts:309-317` (stale-summary cleanup *delete-error log* — the
happy path of pruning is covered).

---

## 2. The shared persistence layer is now tested in isolation (Goal 2)

Previously `persistence.ts` was only exercised indirectly through Square. It now
backs two revenue channels, so it is tested **directly** against a Postgres-faithful
in-memory fake that models the two semantics correctness actually hinges on:

- **upsert-on-conflict** (`onConflict: 'restaurant_id,source,external_id'` for
  catalog; `'restaurant_id,menu_item_id,date'` for summaries) → updates in place,
  never duplicates.
- **insert-dedup** via the pre-insert `SELECT … IN (external_ids)`.

Verified directly: order dedup, restaurant linkage, order-item linkage, summary
aggregation, summary updates (no inflation), cross-source isolation, idempotent
writes, and the legacy no-`external_id` serial path.

---

## 3. Idempotency — proven (Goal 5)

`ingestDoorDash.test.ts` runs the **real** ingest entry point → **real** normalizers
→ **real** shared persistence against the fake DB, twice and three times:

- 1st sync: 5 menu_items, 12 orders, 24 order_items, daily_summaries populated.
- 2nd sync (immediate): `orderCount === 0`; row counts **unchanged**; summary
  revenue **unchanged** (no double-counting).
- 3rd sync: still 5 / 12 / 24.

This exercises the genuine dedup path — deterministic mock data uses **stable
external ids** (`dd-item-*`, `dd-order-*`), which is exactly what production
re-syncs rely on. Revenue in `daily_summaries` reconciles exactly with the sum of
source order totals.

---

## 4. Response-shape assumptions (Goal 3)

### Assumptions **confirmed** (now pinned by tests)

| Assumption | Status |
|-----------|--------|
| Money is integer cents end-to-end | ✅ enforced in normalizers + tests |
| Order total falls back to line-sum when absent (never zeroes revenue) | ✅ tested |
| Stated order total is authoritative over line-sum when present | ✅ tested |
| Missing `created_at` → valid ISO timestamp | ✅ tested |
| Catalog cost unknown → `cost_cents: 0` (operator fills later) | ✅ tested |
| Every record tagged `source='doordash'` | ✅ tested |

### Assumptions **NOT yet validated against the real API** (honest gap)

The client's tolerant parsing — `json.items ?? json.data ?? []` (catalog) and
`json.orders ?? json.data ?? []` (orders) — **could not be validated against a live
DoorDash response**, because:

1. No DoorDash sandbox/partner credentials are available (none in `.env`, none
   provided).
2. DoorDash's Marketplace order/menu endpoints are **partner-gated** — there is no
   public sandbox to call. This is documented in the code itself
   (`doordashClient.ts`, `seedDoorDashSandbox.ts`).

**Mitigation taken instead of faking evidence:** the *contract* the client tolerates
is now pinned by tests (both envelope shapes + the empty fallback), so the parsing
cannot silently drift. The real field names (`id`, `name`, `price`, `total`,
`created_at`, `items[].item_id/quantity/unit_price`) remain **guessed** until a real
payload is observed.

**Cannot yet confirm against real DoorDash:** pagination behavior, exact timestamp
format, monetary field format (cents vs. decimal dollars vs. string), customer/status
structures. These are flagged as remaining risks (§6).

---

## 5. Live sync validation (Goal 4)

A live sync against the production Supabase was **deliberately not run** (the user
opted for the zero-risk path). Instead the equivalent was proven offline: the full
pipeline writes real `orders` / `order_items` / `menu_items` / `daily_summaries`
rows into the in-memory fake, with verified order→item and item→menu_item linkage,
`source='doordash'` on every row, and revenue reconciliation. To capture true
production evidence, run `npm run seed:doordash` against Supabase (mock data, stable
ids → safe to re-run) and snapshot before/after row counts.

---

## 6. Bugs fixed / behaviors clarified

- **No correctness bugs found** in the DoorDash ingestion path — the integration
  behaves as designed under re-sync.
- **Behavior pinned (not a bug):** `DOORDASH_API_BASE_URL` is resolved **once at
  module load** (`const BASE_URL = …`), so it must be set in the process env before
  import; it is not overridable per call. A test originally assumed runtime override
  and was corrected to match — and this is now documented so it can't surprise a
  future deploy.
- **Behavioral difference pinned:** on a failed token refresh, **Square throws +
  marks disconnected**, whereas **DoorDash logs and falls back to the existing
  token** (letting the API surface a clean 401). Both are now locked by tests so
  neither regresses silently.

### Minor production change
`ensureFreshToken` in `ingestDoorDash.ts` was changed from a module-private `const`
to an `export` — mirroring Square's exported `ensureFreshSquareToken` — purely so its
refresh/error-handling path is unit-testable. No behavior change.

---

## 7. Remaining risks

| Risk | Severity | Notes |
|------|----------|-------|
| Real DoorDash payload field names unverified | **High** | `item_id`, `unit_price`, `total`, `created_at`, envelope keys are all guessed. First real partner response may require normalizer changes. Tests will pinpoint exactly what breaks. |
| Monetary format unverified | **High** | Code assumes integer cents. If DoorDash returns decimal dollars or strings, `toCents()` (`Number(amount)`) silently mis-scales revenue. **Validate first** when creds arrive. |
| Pagination not implemented | **Medium** | `fetchOrders`/`fetchCatalog` make a single call with no cursor handling. A real store with many orders would be truncated. |
| Timestamp format unverified | **Medium** | `ordered_at` passed straight through; non-ISO formats would land wrong in `daily_summaries` date bucketing. |
| Live DB sync not exercised | **Low** | Offline-proven; one `seed:doordash` run against Supabase would close this. |

**Recommended next step when DoorDash credentials become available:** capture one
real catalog + orders payload, diff it against the assumptions in §4, update the
normalizers, and replace the tolerant `?? ` fallbacks with a validated schema.
