# T-0019 · Record risk and prompt size in history, and flag low-risk cards over $1 in metrics

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 07:33 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 07:33 intake: intake confirmed; card sha256 6ef962a6e17c8b09af4943c6364c31dfebe0ed72943b8a25af91f578baf2a018 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:33 route: assembly proposed; sha256 3737da17cb2223cad927c7477fe4d798e4429def6cc8b8475349c69cd210012f; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 07:33 route: route approved; assembly sha256 3737da17cb2223cad927c7477fe4d798e4429def6cc8b8475349c69cd210012f (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 07:33 routed to docs, testing, observability: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/ship/history-cost.test.ts)), observability ("metrics" in the title)
- 2026-11-23 07:33 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
