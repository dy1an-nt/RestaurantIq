---
name: how
description: "Use for \"how does X work\", a walkthrough before changing something you don't know well, and placement questions (\"where should this live\", \"which layer owns this\"). Explains runtime flow, subsystem architecture, and file ownership, and can critique the architecture. Use /why for historical motivation, and the teaching-agent when the output is a committed doc."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?". Produce an explanation at the level of a senior engineer onboarding onto a subsystem: enough to build a working mental model, not annotated source code.

Two modes:

1. **Explain** (default). Explore, then explain.
2. **Critique.** Explain first, then run an adversarial architectural pass over what you found.

## How this differs from the neighbours

- `/why` answers what forces led to the code's shape. This answers what it does and how the pieces fit.
- `teaching-agent` writes durable developer-facing docs: sprint handoffs, onboarding guides, case studies, and it knows where each of those lives. This skill answers a question in the session. If the answer is meant to be committed as a doc, hand the work to `teaching-agent` instead of writing it here.
- Operating Discipline already requires reading a file and its immediate neighbours before editing it. This is that step, run deliberately and written down, for a subsystem you don't know yet.

## Explain mode

### Step 1. Understand the question and its scope

Parse what is being asked: a subsystem ("how does the sync scheduler work"), a feature flow ("how does DoorDash ingestion reach `daily_summaries`"), an architectural overview, or a runtime trace ("what happens when a user loads the dashboard").

If the target is ambiguous, state your best-guess interpretation in one line and start. Don't ask. The user can redirect.

### Step 2. Explore

Start with what this repo already wrote down, because it is faster than reading source and it is usually right:

- `RestaurantIQ/docs/sharp-edges.md` for the traps in the area
- `RestaurantIQ/docs/schema.md` and `docs/migrations.md` for anything touching the database
- `RestaurantIQ/docs/archive/sprint-notes/` for the sprint that built it
- `docs/bugs.md` when the code looks defensive

Then read the code, following the repo's own seams: route to controller to service on the backend, page to context to fetch on the frontend. Read the actual code. Never describe a file you did not open.

**Assess breadth before spending anything:**

- **Narrow** (a single service, route, component, or utility): do it inline in the main session. This is most questions. No subagents.
- **Wide** (a flow crossing backend and frontend, or a full subsystem overview): you may split the question into 2 to 4 non-overlapping angles and launch that many `Explore` agents in a single message. `Explore` is read-only and returns conclusions rather than file dumps, which is what you want here.

Lean narrow when in doubt. You can always fan out after the inline pass hits a wall. Spawning agents costs real usage (CLAUDE.md, lightweight path), and the upstream version of this skill spent a subagent even on simple questions; that part is deliberately not ported.

Write the explanation yourself. Do not spawn an agent whose only job is to write up findings you already have.

### Step 3. Present

**Overview.** One or two paragraphs. What it is, what it does, why it exists. Enough for the reader to decide whether to keep reading.

**Key concepts.** The types, services, and abstractions needed to follow the rest. Not exhaustive.

**How it works.** The core of the explanation. What triggers it, what happens step by step, where the data goes, the decision points. Prose, not pseudocode. Name specific files and functions so the reader can go look, without dumping code blocks unless a snippet is genuinely necessary.

**Where things live.** A short map of the files needed to start working in this area.

**Gotchas.** The non-obvious things that would trip someone up, and the sharp edges. Cross-reference `docs/sharp-edges.md` rather than restating it.

Skip any section the question doesn't need. Cite real `file:line`. If you are inferring rather than reporting something you read, say so in the sentence; a confident walkthrough of code you skimmed is worse than an honest gap.

## Critique mode

Use when the question asks for architectural problems or improvements, not just understanding.

### Step 1. Explain first

Run the explain flow above in full. You cannot critique an architecture you have not traced.

### Step 2. One adversarial pass

Launch a `qa-agent` with the explanation, the file paths, and the rubric in `references/critique-rubric.md`. That agent is this repo's read-only adversarial reader, and it already carries the auth, tenant-scoping, and money invariants.

Upstream spawns four critics across four providers here. One `qa-agent` is the equivalent that fits this repo's budget and its existing roles. If the subsystem is genuinely contested, run a second pass with a different framing rather than four parallel ones.

If the subsystem touches auth, tenant scoping, or money, the `qa-agent` pass is required, not optional (CLAUDE.md).

### Step 3. Lead judgment

You are a pragmatic lead, not an aggregator. Sort every finding:

- **Act on.** Real architectural problems worth fixing now.
- **Consider.** Real concerns whose cost and benefit are unclear.
- **Noted.** Valid observations, low priority.
- **Dismissed.** Wrong, missing context, or a style preference. Say which.

Present the explanation first, then the verdict below it. Someone who only wanted to understand the system should not have to wade through the critique to get there.

## Reference files

- `references/critique-rubric.md`. The lenses for critique mode: abstraction fit, data model, boundary discipline, evolution readiness, complexity versus value, consistency.

---

Adapted from the `how` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (MIT). The explorer, explainer, and multi-provider critic subagents were replaced with an inline pass, the built-in `Explore` agent, and this repo's `qa-agent`.
