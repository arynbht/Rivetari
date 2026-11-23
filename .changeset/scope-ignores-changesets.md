---
"@arynbht/rivetari-runtime": patch
---

Tier 1 no longer checks every package because a change carries a changeset or root docs: `.changeset/`, `docs/` and root Markdown don't widen the affected scope. A change made only of them still checks everything.
