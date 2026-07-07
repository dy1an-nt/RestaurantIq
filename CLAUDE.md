# RestaurantIQ — repo root

All application code and docs live in the nested `RestaurantIQ/` directory:
`RestaurantIQ/restaurantiq-backend`, `RestaurantIQ/restaurantiq-frontend`,
`RestaurantIQ/docs`. The canonical project instructions are imported below and
bind the main session, not just subagents — in particular the **Operating
Discipline** and **Orchestration protocol** sections.

@RestaurantIQ/CLAUDE.md

## Root-level notes

- `docs/sharp-edges.md` paths in the imported file are relative to the nested
  dir: `RestaurantIQ/docs/sharp-edges.md` from here.
- `ENGINEERING_REVIEW*.md` / `*_Engineering_Review*.pdf` under `RestaurantIQ/`
  are gitignored, local-only review documents. Never commit, quote publicly,
  or delete them.
- A SessionStart smoke check (`.claude/smoke-check.sh`) verifies env files,
  key deps, agent definitions, and a clean `tsc --noEmit` in both packages.
  If it reported a failure at session start, fix that before anything else.
