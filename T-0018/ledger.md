# T-0018 · Reject a touches glob that matches more than 20 files at intake

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 07:19 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 07:19 intake: intake confirmed; card sha256 748cba8c626c8f6b50358f0d1406559fee2babf2263765627198c3aa409f05a9 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:19 route: assembly proposed; sha256 4907ecd262d5c1154132a395714ff8e10f44bd1d64d41a6480e9bdb2913e0940; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 07:19 route: route approved; assembly sha256 4907ecd262d5c1154132a395714ff8e10f44bd1d64d41a6480e9bdb2913e0940 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 07:19 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/task/touches-cap.test.ts); "test" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 07:19 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
