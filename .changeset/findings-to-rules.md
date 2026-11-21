---
"@arynbht/factory-catalog": minor
"@arynbht/factory-engine": patch
"@arynbht/factory-runtime": minor
"@arynbht/factory": minor
---

Recurring judge findings can now become rules. Every tier 2 finding carries a stable `pattern` id, and a closed task's history row records its findings by pattern. `factory metrics` (and `factory metrics --findings`, which needs no GitHub) reports the judge's tier 1 rule count, findings per PR, how often each pattern recurs, and any pattern seen in two or more PRs as a candidate rule. Tier 1 gains three diff rules that fail closed: no new code comments (opt in with `quality.no-new-comments` in the profile), no Markdown added or edited unless the card names it, and no new suppressions or skipped and focused tests. The catalog gains `quality.boundaries.clean`, which runs a repo's `boundaries` script when it has a dependency-cruiser config.
