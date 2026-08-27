---
name: tdd
description: "Use only when the user explicitly asks for TDD, a failing test, or a regression test, OR when the bug has an obvious cheap local test target. Skip when the test path is unclear, expensive, integration-heavy, or not requested."
disable-model-invocation: true
---

# TDD bug fix

When fixing a bug with a clear, cheap test path, make the broken behavior executable before changing production code. The goal is a focused regression test that fails before the fix and passes after it.

Do not force a test when it would be impractical. If the available test would require broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn, skip adding a new test and use the closest useful verification instead.

## Where tests live in this repo

- **Backend:** Jest + ts-jest. Tests sit in `src/**/__tests__/*.test.ts` next to the code they cover (see `src/services/doordash/__tests__/` for the fullest examples of mocking an external client). Run with `npm test` in `restaurantiq-backend/`, or `npm test -- <pattern>` for one file.
- **Frontend:** no test runner is installed. Do not add one to fix a bug. The regression check for a frontend bug is the running page plus `npx tsc --noEmit`, and the "failing test is impractical" section below applies.

## Workflow

1. **Understand the bug.** Identify the intended behavior, current behavior, affected path, and smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest existing test file for that codepath. If no practical test path is obvious, do not create one from scratch just to satisfy the workflow.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. The test should encode intended behavior, not mirror the current implementation.
4. **Run the new test before fixing.** Confirm it fails for the intended reason. If it passes or fails for an unrelated reason, correct the test or reproduction before editing the implementation.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior while preserving nearby contracts.
6. **Rerun the regression test.** Confirm it now passes.
7. **Run nearby validation.** `npx tsc --noEmit` in every package touched, the adjacent test files, and a `curl` against the route when the change has broader risk.

## If a failing test is impractical

Do not silently skip the regression step. Before fixing, explicitly explain why a failing test is impossible or not worth the cost, then choose the closest executable regression check available: a targeted script, a `curl` against the endpoint, a manual reproduction in the running app, a log assertion, or a focused integration check.

Prefer no new test over a bad test. A bad test is one that mostly tests mocks, encodes current implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, or would be deleted immediately after proving the fix.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior has genuinely changed and the reason is clear.
- Keep the regression test focused on the bug; avoid broad fixture churn or unrelated coverage expansion.
- Do not add tests when the practical signal is weak; use manual or scripted verification and say why.
- If the bug is flaky, make the test deterministic where possible and document the signal being locked down.
- If the bug exposes a broader class of failures, first land the focused regression path, then consider additional sibling coverage.
- Money assertions are in integer cents. A test that asserts a float is testing the wrong thing.

## Final response

Report the evidence, not just the outcome:

- Name the failing-before test or executable check and quote the failure it produced.
- Name the passing-after test run and any nearby validation performed.
- If failing-before evidence could not be demonstrated, state why and describe the closest regression check used instead.

Paraphrased results don't count (Operating Discipline, Reporting).

---

Adapted from the `tdd` skill in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (MIT).
