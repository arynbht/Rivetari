# T-0025 · Have init use the stack detector and seed the banned list from it

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 11:10 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 11:10 intake: intake confirmed; card sha256 d60bfba485fadad1646a148c60184e6b0fbebdb0544e5a460d573418a3e945fa (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 11:10 route: assembly proposed; sha256 cefadfd4ef51cfaaa98a234ff75032d61bcd8f238a1e94d30fdf6a145722f8ad; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 11:10 route: route approved; assembly sha256 cefadfd4ef51cfaaa98a234ff75032d61bcd8f238a1e94d30fdf6a145722f8ad (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))

## Decisions

- 2026-11-23 11:10 routed to docs, data, testing: docs (touches **/*.md (.changeset/init-detects-stack.md); skill native-writing triggers on **/*.md (.changeset/init-detects-stack.md)), data ("seed" in the title), testing (touches **/*.test.* (packages/cli/src/commands/init-stack.test.ts))
- 2026-11-23 11:10 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 11:10 data: no vendored skill covers it; the agent works from the spine
