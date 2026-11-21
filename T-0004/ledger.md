# T-0004 · Keep a customised factory.yml when init runs with --force

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-21 17:59 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-21 18:03 intake: intake confirmed; card sha256 39d700792dd810c6b1a5301e8dbe1a8084680b42da5e6f6e4d0d9c31d8d147fe (arynbht@gmail.com (--yes))
- 2026-11-21 18:03 route: assembly proposed; sha256 a30493cb320b4b072563334dfb202c42af92536fddff7bdf790c15883d2c3651; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-21 18:13 route: route approved; assembly sha256 a30493cb320b4b072563334dfb202c42af92536fddff7bdf790c15883d2c3651 (arynbht@gmail.com (--yes))

## Decisions

- 2026-11-21 18:03 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/cli/src/commands/init.test.ts))
- 2026-11-21 18:03 under the threshold, for the approver: workflow
- 2026-11-21 18:03 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
