# T-0021 · Decide keyword-only borderline sectors as not in, without holding the route

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 08:25 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 08:25 intake: intake confirmed; card sha256 e909b1462b11fcdf098e49db79b10a53ff3edb574536e03990cccee2b387db7e (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 08:25 route: assembly proposed; sha256 e90dda38a000ae8c16d6999c2d485b03ba2c36db9aee0412f0c099d9168fdb9d; skills none; proof infra-plan; awaiting approval (rivetari router (for arynbht@gmail.com))

## Decisions

- 2026-11-23 08:25 routed to testing, docs, infra: testing (touches **/*.test.* (packages/runtime/src/task/keyword-borderline.test.ts); "test" in the description), docs (touches **/*.md (.changeset/keyword-borderline.md); skill native-writing triggers on **/*.md (.changeset/keyword-borderline.md)), infra ("iac" in the description; skill terraform-skill triggers on iac)
- 2026-11-23 08:25 under the threshold, for the approver: security, perf, workflow, observability
- 2026-11-23 08:25 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:25 terraform-skill matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:25 infra: no vendored skill covers it; the agent works from the spine
