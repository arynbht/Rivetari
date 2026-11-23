# T-0010 · Let a confirmed card be amended before isolate

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 01:15 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 01:15 intake: intake confirmed; card sha256 e0c50a614455ff7f726a934b5b273bb74588c4c726fdd155fc3bb0adf9e3d884 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 01:15 route: assembly proposed; sha256 8cd772713b490ed28560278d09e3b2a1091416d81d79e7a6422c6383ab1cd8a3; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 01:15 route: route approved; assembly sha256 8cd772713b490ed28560278d09e3b2a1091416d81d79e7a6422c6383ab1cd8a3 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 01:15 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); "docs" in the description; skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/task/amend.test.ts))
- 2026-11-23 01:15 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
