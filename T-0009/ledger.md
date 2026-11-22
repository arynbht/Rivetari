# T-0009 · Skip generated files when looking for new check suppressions

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-22 21:45 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-22 21:46 intake: intake confirmed; card sha256 0d352309a3e5ccb35c0372d87ca0e08dc706e90246bb18a9bcf3a871c5dffb79 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 21:46 route: assembly proposed; sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-22 21:46 route: route approved; assembly sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c (arynbht@gmail.com (--yes))

## Decisions

- 2026-11-22 21:46 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/**/*.test.ts))
- 2026-11-22 21:46 under the threshold, for the approver: security
- 2026-11-22 21:46 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
