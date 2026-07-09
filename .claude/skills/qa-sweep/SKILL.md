---
name: qa-sweep
description: Pre-completion spot-check for inline (non-sprint) RestaurantIQ changes — the QA agent's grep sweep plus typecheck, run by the main session before claiming a small fix done. Use after any lightweight-path edit to backend or frontend code. If the change touches auth, tenant scoping, or money handling, this sweep is NOT enough — launch a real qa-agent security pass.
---

# QA Spot-Check (lightweight path)

For small fixes done in the main session without subagents. Run every step over
what you touched before claiming done. This does not replace the Operating
Discipline hard gates — it is part of gate 4.

## Escalation rule (not negotiable)

Anything touching **auth, tenant scoping, or money handling** gets a real
`qa-agent` security pass regardless of size. The sweep below is for everything
else.

## The sweep

```bash
# Convention violations — console.log is forbidden (only console.error allowed)
grep -rn "console.log" RestaurantIQ/restaurantiq-backend/src RestaurantIQ/restaurantiq-frontend/src

# Float math on money — money is integer cents, formatted only in the frontend
grep -rn "parseFloat\|toFixed\| \* 0\.01" RestaurantIQ/restaurantiq-backend/src

# Tenant scoping — every controller must scope by req.user (spot-check files you touched)
grep -rn "req.user" RestaurantIQ/restaurantiq-backend/src

# Effect hygiene — async useEffects need a cancelled flag checked before setState
grep -rn "useEffect" RestaurantIQ/restaurantiq-frontend/src
```

Grep output alone isn't a verdict — read each hit in the files you touched and
confirm it's clean (a pre-existing hit elsewhere is reported, not silently fixed).

## Also verify

- `npx tsc --noEmit` exits 0 in every package touched.
- `{ data, error }` response shape intact on any route touched.
- New/changed API calls verified against a definition read this session (never
  invented).
- Any pattern-level bug found goes to `RestaurantIQ/docs/sharp-edges.md` (and
  the war story to `docs/bugs.md`) — not just the report.
