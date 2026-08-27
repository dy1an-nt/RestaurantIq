---
name: sprint
description: "Run a full RestaurantIQ sprint with the seven-agent team (architect, then backend and frontend, then security, QA, devops, teaching). Use when building a feature or any multi-file vertical slice: \"run a sprint\", \"build [feature]\", \"Sprint V\". NOT for single-file bug fixes, doc updates, or small refactors; those stay in the main session per AGENTS.md's lightweight path (use /qa-sweep before calling them done)."
---

# Sprint

The canonical procedure is in
[`../../../.claude/skills/sprint/SKILL.md`](../../../.claude/skills/sprint/SKILL.md).

Before acting, read that file completely and follow it. Resolve any relative
references from the canonical skill directory. This wrapper exists only so
Codex can discover the shared skill; do not duplicate the procedure here.

## Codex overrides

The canonical file is written for the Claude session. Two of its paths differ
here, and these overrides win wherever the canonical text disagrees:

- Agent definitions live in `.codex/agents/`, not `.claude/agents/`.
- The Operating Discipline it defers to is in `RestaurantIQ/AGENTS.md`, not
  `RestaurantIQ/CLAUDE.md`.

Everything else in the canonical playbook applies unchanged.
