---
"@arynbht/rivetari-runtime": minor
---

The build prompt lists the rules the judge checks on the diff before anything else, one line each: every enabled diff rule (no new comments when the profile turns it on, Markdown only where the card names it, with the card's paths, no new suppressions) and every banned pattern in `.rivetari/banned.json` at the base. They're generated from the same sources the judge reads, so the agent meets them on the first pass instead of learning them from a failed round.
