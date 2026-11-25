# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo. Domain docs live in the nested `RestaurantIQ/` directory, next to the rest of the project docs, not at the repo root.

## Before exploring, read these

- **`RestaurantIQ/CONTEXT.md`**: the domain glossary.
- **`RestaurantIQ/docs/adr/`**: read ADRs that touch the area you're about to work in.

If either doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

These sit alongside the existing canonical docs, not over them. `RestaurantIQ/docs/schema.md` stays canonical for tables, and `RestaurantIQ/docs/sharp-edges.md` stays canonical for known pitfalls.

## File structure

```
RestaurantIQ/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-another-decision.md
├── restaurantiq-backend/
└── restaurantiq-frontend/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (example decision), but worth reopening because..._
