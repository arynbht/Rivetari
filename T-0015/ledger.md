# T-0015 · Stop git-heavy tests failing tier 1 under load

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 03:34 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 03:34 intake: intake confirmed; card sha256 522a29dec1657f13b2a3429361b9ef8e2fe79f5808159fe65f9496df5c6b78b9 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 03:34 route: assembly proposed; sha256 7fed0408d38b5c580d15c6c935522130458d39f4cf6df3cccc676c8eafcfd189; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 03:34 route: route approved; assembly sha256 7fed0408d38b5c580d15c6c935522130458d39f4cf6df3cccc676c8eafcfd189 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 03:34 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/judge/flaky-under-load.test.ts); "test" in the title; "flaky" in the description; "coverage" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 03:34 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
