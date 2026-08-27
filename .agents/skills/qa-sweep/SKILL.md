---
name: qa-sweep
description: "Pre-completion spot-check for inline, non-sprint RestaurantIQ changes: the QA agent's grep sweep plus typecheck, run by the main session before claiming a small fix done. Use after any lightweight-path edit to backend or frontend code. If the change touches auth, tenant scoping, or money handling, this sweep is NOT enough; launch a real qa-agent security pass."
---

# QA sweep

The canonical procedure is in
[`../../../.claude/skills/qa-sweep/SKILL.md`](../../../.claude/skills/qa-sweep/SKILL.md).

Before acting, read that file completely and follow it. Resolve any relative
references from the canonical skill directory. This wrapper exists only so
Codex can discover the shared skill; do not duplicate the procedure here.
