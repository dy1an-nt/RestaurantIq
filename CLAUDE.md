# RestaurantIQ repo root

This file is the Claude entrypoint. It mirrors [`AGENTS.md`](AGENTS.md), the
Codex entrypoint. The block between the `shared:root-instructions` markers below
must be byte-identical in both files; `scripts/check-docs.mjs` fails CI if it
drifts. **Edit both, or neither.**

## Layout

All application code and docs live in the nested `RestaurantIQ/` directory:
`RestaurantIQ/restaurantiq-backend`, `RestaurantIQ/restaurantiq-frontend`,
`RestaurantIQ/docs`. The canonical project instructions are imported below and
bind the main session, not just subagents. The **Operating Discipline** section
applies in particular.

Paths inside `RestaurantIQ/CLAUDE.md` are relative to that nested directory.
From the repo root, prefix them: `docs/sharp-edges.md` there is
`RestaurantIQ/docs/sharp-edges.md` here, and `docs/schema.md` is
`RestaurantIQ/docs/schema.md`.

@RestaurantIQ/CLAUDE.md

<!-- shared:root-instructions:start -->
<!-- Everything between these markers must be byte-identical in AGENTS.md and
     CLAUDE.md. scripts/check-docs.mjs fails CI if they drift. Edit both. -->

## Skills

Sprint orchestration, migrations, and the pre-done QA spot-check live as skills
in `.claude/skills/` (`/sprint`, `/migrate`, `/qa-sweep`). Codex discovers
matching wrappers in `.agents/skills/`; the wrappers point back to the canonical
Claude procedures so the two copies do not drift. Invoke the skills rather than
working from memory of them.

Five more skills are ported from [pstack](https://github.com/cursor/plugins/tree/main/pstack)
(MIT, by Lauren Tan) and adapted to this repo. They are optional tools, not gates:

- `/blast-radius`. Before shipping a change you don't fully trust, find what it
  breaks elsewhere and prove the one fact it's safe because of.
- `/how`. Trace how a subsystem works before changing it, and optionally
  critique its architecture. `teaching-agent` still owns committed docs.
- `/why`. Reconstruct design rationale from git, `gh`, and `RestaurantIQ/docs/`
  with explicit confidence tiers.
- `/tdd`. Failing-test-first bug fixing, when a cheap Jest target exists.
- `/unslop`. Cut AI tells from prose before it ships. The only one an agent may
  invoke on its own; the other four are user-invoked.

The upstream license text is preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Root-level notes

- `ENGINEERING_REVIEW*.md` / `*_Engineering_Review*.pdf` / `INTERVIEW_NOTES.md`
  under `RestaurantIQ/` are gitignored, local-only documents. Never commit,
  quote publicly, or delete them.
- A SessionStart smoke check (`.claude/smoke-check.sh`) verifies env files, key
  deps, agent definitions, and a clean `tsc --noEmit` in both packages. It is
  wired for Claude in `.claude/settings.json` and for Codex in
  `.codex/hooks.json`. If it reported a failure at session start, fix that
  before anything else.
<!-- shared:root-instructions:end -->
