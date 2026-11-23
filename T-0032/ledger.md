# T-0032 · Route a Markdown-only card on its touches, not its wording

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 23:12 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 23:12 intake: intake confirmed; card sha256 dc9d321ded6cb3b84ae0e6be36113d57d891df9b1a2b4374480859ff3134b8fe (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 23:12 route: assembly proposed; sha256 a5dedfbd8bfa82fbaa5097ca5f7c38f6527caeb93ea2e4eb3668d020d1c69e01; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 23:12 route: route approved; assembly sha256 a5dedfbd8bfa82fbaa5097ca5f7c38f6527caeb93ea2e4eb3668d020d1c69e01 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 23:12 risk low: no high or medium signal in the touches
- 2026-11-23 23:12 routed to docs, testing: docs (touches **/*.md (.changeset/docs-only-ui.md); "docs" in the description; "documentation" in the description; skill native-writing triggers on **/*.md (.changeset/docs-only-ui.md)), testing (touches **/*.test.* (packages/runtime/src/router/docs-only-ui.test.ts); "test" in the description)
- 2026-11-23 23:12 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
