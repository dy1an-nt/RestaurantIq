---
name: why
description: "Use for 'why does X work this way', 'why did we pick Y', design rationale, a regression whose history matters, or 'where did this number come from'. Reconstructs intent from git, gh, and this repo's own written record, with explicit confidence tiers and honest gaps. For what the code does right now, just read the code."
disable-model-invocation: true
---

# Why

Investigate the motivation and intent behind code. Why was it built this way? What edge cases were considered? What product or operational constraint shaped the design? What alternatives were rejected, and why?

This answers what forces led to the code's shape. It does not answer what the code does; for that, read the code.

## How this skill works here

Historical context for this project lives in three places, and all three are local:

1. **Git and GitHub.** Commit history, PR bodies, review threads, inline comments, test names.
2. **The written record in `RestaurantIQ/docs/`.** This repo keeps an unusually good one, and it is usually the fastest path to an answer:
   - `docs/sharp-edges.md` for the canonical pitfalls
   - `docs/bugs.md` for the full war stories behind them
   - `docs/archive/sprint-notes/` and `docs/sprints-overview.md` for what a sprint was trying to do
   - `docs/known-limitations.md` for constraints accepted on purpose
   - `docs/migrations.md` and `docs/schema.md` for schema decisions
3. **The user.** Some rationale was never written down anywhere.

Do this inline in the main session. The upstream version of this skill fans out seven parallel MCP-backed investigators (Linear, Notion, Slack, Sentry, Datadog, a warehouse) plus a synthesizer. None of those systems are connected here, and CLAUDE.md is explicit that subagents cost real usage and are for sprints, not questions. Escalate to subagents only when the archaeology is genuinely wide, and say why when you do.

## Operating posture

Operate as a careful, cautious, precise investigator. Think like a detective piecing together a historical case from fragmentary records. When the record is thin, say so.

- **Evidence before narrative.** Collect the pieces first, then see what story they support. Never pick a story and recruit the evidence that fits it.
- **Precision over polish.** Prefer the exact quote and citation over a smooth paraphrase. A reader should be able to follow any claim back to its source and verify it in under a minute.
- **Consider what you haven't seen.** The evidence you find is a sample. Before concluding, ask what you would expect to see if an alternative explanation were true, and whether you looked for it.
- **Name the gaps.** If a thread goes cold or a question has no answer, document the gap. Don't paper it over with an authoritative-sounding guess.
- **Hedge on purpose.** When evidence is indirect, the language should signal it ("appears to", "likely", "suggests"). That is a feature of the output, not a stylistic choice to override.
- **No shortcut by code-reading.** The code tells you what it does, rarely why it exists. Resist inferring intent from code shape.

## Core epistemics

This skill builds a patchwork understanding from fragmented evidence. Commit messages lie. People change their minds between the PR description and the implementation. Be ruthlessly honest about what you know versus what you're inferring. The goal is not a satisfying story; it is to surface evidence, calibrate confidence, and let the user decide.

- **Cite everything.** Every claim about intent references a specific commit hash, PR number, doc path, or `file:line`. If you can't cite it, it's inference, and must be labeled as such.
- **Prefer "appears to" over "because".** Reserve confident language for direct, explicit evidence.
- **Surface contradictions.** If two sources disagree, show both.
- **Acknowledge gaps.** An honest "we couldn't find out why" beats a confident guess.
- **Multiple hypotheses are valid.** When the evidence fits several stories, present them all.
- **Beware rationalization.** Code that makes sense today may have been written for reasons that no longer apply, or for no good reason at all.

Read `references/epistemics.md` for the full confidence framework and phrasing guide, and follow it.

## Step 1. Understand the target and the question

The **target** is a chunk of code, a pattern, a feature, or a named decision. The **question** is usually one of: design rationale, tradeoffs and alternatives, the edge case that motivated a defense, the external constraint, whether dead code is really dead, or a broad history sweep.

If the target is vague, make your best guess from context, state your interpretation in one line so the user can redirect, then proceed.

## Step 2. Establish the code anchor

Anchor in concrete code before searching anything. You need the file paths and line ranges, the key symbols, the last few commits touching the target, and any PR numbers.

```bash
# Blame target lines for last-touch commits
git blame -L <start>,<end> <file>

# Last N commits touching the file, PR numbers visible
git log --oneline -20 -- <file>

# Full file history, with patches, through renames
git log --follow -p -- <file>

# Commits that added or removed this exact text
git log -S '<exact_string_from_code>' -- <file>

# The full commit message, for ticket and PR references
git log -1 --format=%B <commit>
```

Pull PR bodies and discussion for substantive commits:

```bash
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,comments,reviews
```

`references/code-archaeology.md` has the fuller search playbook and the pitfalls (squash-merge flatlands, misleading commit messages, cargo-culted patterns, bot commits).

## Step 3. Search the written record

Search `RestaurantIQ/docs/` for the symbol, the feature name, the constant, and the sprint that shipped it. `docs/bugs.md` in particular is where a defensive-looking guard usually has its story, and a hit there is direct evidence, not inference.

```bash
rg -n -i '<symbol|feature|constant>' RestaurantIQ/docs/
rg -n -C2 '(TODO|FIXME|HACK|XXX|NOTE)' <target_file>
rg -l '<symbol>' --glob '*test*'
```

A search that finds nothing is a result. Record what you searched and what came back empty; "not ticketed, not documented" is itself evidence about how the decision got made.

## Step 4. Present

**The question.** Restate what was asked, concisely.

**The code in question.** File paths, line ranges, key symbols. One or two lines so the reader is anchored.

**What we found (direct evidence).** Claims with explicit citations: commit hash, PR number, doc path, `file:line`. Each bullet is something with textual evidence behind it. Quote or closely paraphrase the source.

**What we can reasonably infer.** Claims supported by indirect evidence or converging signals but stated nowhere. Each bullet makes the inference chain explicit: "Given A and B, C seems likely because D." Hedged language only.

**Competing hypotheses.** If the evidence fits several stories, list each with the evidence for and against. Don't force a winner the record doesn't support. Skip this section when there's a clear answer.

**What we don't know.** Explicit gaps. Be specific: "searched `docs/` for 'rate limit' and the 4 PRs touching this file since March; none discuss where 200 came from" is more useful than "we don't know."

**Sources consulted.** One line per source, including the ones that came back empty, formatted as `- <source>: <what was searched>. <what was found, or "no relevant results">.`

If the question is a precursor to actually changing the code, close by converting the findings into a Preserve / Change / Avoid / Risk constraint set for the change.

## Common failure modes to avoid

- **Confident storytelling.** A plausible narrative built from thin evidence. A bullet with no citation goes in "inferred" or "hypotheses", not "what we found".
- **Citing the code as evidence for its own intent.** "Handles the null case because it checks for null" is mechanics, not motivation.
- **Recency bias.** The most recent commit is not authoritative. The current shape is usually accreted. Trace back.
- **Sycophantic agreement.** If the user supplies a hypothesis ("I assume this is for performance?"), treat it as one candidate and check it independently.
- **Skipping the gaps section.** The honest accounting of what you couldn't find out is part of the value.

## Reference files

- `references/epistemics.md`. Confidence tiers and phrasing guide. Follow it.
- `references/code-archaeology.md`. Git and `gh` search playbook, what good evidence looks like, and the pitfalls.

---

Adapted from the `why` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (MIT). The seven-MCP parallel investigation was collapsed to an inline git-plus-docs investigation for this repo.
