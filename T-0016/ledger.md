# T-0016 · Stop git-heavy tests failing tier 1 under load

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 05:46 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 05:46 intake: intake confirmed; card sha256 7d5e01b99f86c24ebf9fe1387180f6d2db2e5367fa3005f3ec11a9646adff200 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 05:46 route: assembly proposed; sha256 b68bb35a2c0fe17200d19a3bf7286b187be03d577ebcbba79cd2e429edc8b3c0; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 05:46 route: route approved; assembly sha256 b68bb35a2c0fe17200d19a3bf7286b187be03d577ebcbba79cd2e429edc8b3c0 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 05:46 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/judge/flaky-under-load.test.ts); "test" in the title; "flaky" in the description; "coverage" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 05:46 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
