---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

`rivetari metrics` counted every judge finding in "Findings per PR", suggestions included, so this repo showed 2.1 while the trust ladder's blocking-per-PR was 0.10. The line is now "Blocking findings per PR" and counts blocking findings only, as the ladder does. The suggestions get a line of their own with their count and their rate per PR. `findingsMetrics` also returns `blocking` and `suggestions`, and its `findingsPerPr` is now blocking findings only.
