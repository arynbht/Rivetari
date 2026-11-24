---
"@arynbht/rivetari-runtime": minor
---

A test has to prove something. For fix and feature cards, tier 1 runs each new test file alone on the base commit with the change's version of it; a file that passes there proves nothing about the change, the review is told, and the criterion it backs is unverified, for a person. Refactor, chore and spike cards are exempt, and the round's notes say so. When the tests had to run on the base and couldn't (no test run on the change, or a runner tier 1 can't point at one file), the criteria they back are unverified too, never passed.
