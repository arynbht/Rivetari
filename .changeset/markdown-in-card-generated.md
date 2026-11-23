---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-runtime": minor
---

The profile takes an optional top-level `generated` list of globs. Tier 1's `diff.markdown-in-card` no longer fails Markdown under those globs or under `.changeset/`, so a change that regenerates docs (such as `docs/catalog/*.md` after a new catalog control) or adds the changeset a published package needs passes without the card naming those paths. An unnamed README or other hand-written Markdown still fails. The build prompt's line for the rule names the paths it skips.
