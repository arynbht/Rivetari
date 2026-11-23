---
"@arynbht/rivetari-runtime": patch
---

The build and plan prompts get a capped repo slice: the card's source touches, the files they import directly by relative path (one level, no bare package imports), and the test files beside those sources. A test glob in the card's touches, such as `packages/**/*.test.ts`, is no longer expanded, so it can't pull in every test in the repo; T-0011's slice was 61k tokens re-read on 48 turns. The plan call gets the same slice and runs in plan mode with a 4-turn limit (`--max-turns 4`). The build-start ledger line records the assembled prompt's approximate size, `~N prompt tokens`, next to the file count.
