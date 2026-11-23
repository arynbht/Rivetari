---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

Intake refuses a card whose `touches` has a glob matching more than 20 of the repo's tracked files, before an id is reserved for it. A card's touches feed the build prompt's slice, the router and the fast path, and a glob such as `packages/**/*.test.ts` can name hundreds of files. The message names the glob, how many files it matches and the first few of them, and asks for the files by name or a narrower glob. `rivetari task new` checks cards given with `--touches` and with `--from` alike. A plain path, a glob matching 20 files or fewer, and a glob that matches no tracked file yet (for new files) are accepted. The runtime exports the check as `checkTouches` and the cap as `TOUCHES_CAP`.
