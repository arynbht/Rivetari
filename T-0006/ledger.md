# T-0006 · Keep a customised factory.yml when init runs with --force

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-22 05:34 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-22 05:34 intake: intake confirmed; card sha256 6ba3285b7dfaffd8aa361cb1e8546f9bfbeb3c4bde1316e6b8efbe6c059bdc9f (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 05:34 route: assembly proposed; sha256 4bfb45207db71ac83c4bbc8d667a669baf5cdff1a7db1f076c18921b29ca83cc; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-22 18:12 route: route approved; assembly sha256 4bfb45207db71ac83c4bbc8d667a669baf5cdff1a7db1f076c18921b29ca83cc (arynbht@gmail.com (--yes))
- 2026-11-22 18:12 isolate: worktree .worktrees/T-0006 · branch fix/t-0006 from origin/main (a263712cba56) · port 5174 · db software_factory_dev_t0006 · env sha256 9fea1b044b8cce9110988c56674f594009c9dbd634b9310b7c2bc8bbb5b6ea35 (factory runtime (for arynbht@gmail.com))
- 2026-11-22 18:13 build: build started · skills spine only · budget 8 steps / 60k ctx · 36 repo file(s) in context · 216876 tokens · $0.42 · 5 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-22 18:16 build: build paused: 1 thing(s) to ask about · commit 111feb8e6463 · 950069 tokens · $0.68 · 22 turns (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-22 18:13 1. In packages/cli/src/commands/init.ts, change how runInit writes .github/workflows/factory.yml. Today it calls writeReplacing(..., flags.force). Instead, always use the non-force path of writeBeside, either by calling writeBeside(root, rel, content, false) or by pulling that path out into a small helper. Result: a missing file is written from the template, an identical one is left alone, and a different one stays byte-for-byte unchanged while the template goes to .github/workflows/factory.factory.yml. This holds with or without --force, and factory.yml is never backed up or replaced. Other generated files (AGENTS.md and the rest) keep their current --force behaviour.
- 2026-11-22 18:13 2. Change the note init prints for factory.yml. It must name .github/workflows/factory.factory.yml and say to merge it by hand. It should also warn that this sibling runs on GitHub as a live workflow, so it should be merged and deleted, not committed. A T-0004 judge finding and the no-generated-file-in-workflows rule flagged exactly this. Update writeReplacing's doc comment (it no longer covers factory.yml) and the '--force never deletes' comment in runInit to match. Match the file's voice, and add no section-number references in comments.
- 2026-11-22 18:13 3. Add new tests to packages/cli/src/commands/init.test.ts for A1. Run init, overwrite factory.yml with custom content, then run init --force with a different phase. Assert that factory.yml is byte-for-byte unchanged, that factory.factory.yml equals the template (it contains the new gate and matches a fresh render), and that no factory.yml.bak exists.
- 2026-11-22 18:13 4. Add tests for A2. On a repo with no factory.yml, init without --force writes factory.yml from the template, with no sibling. Then delete factory.yml and run init --force: factory.yml is written again from the template, with no sibling and no .bak.
- 2026-11-22 18:13 5. Add a test for A3. Spy on process.stdout.write during an init --force over a customised factory.yml. Assert the output names .github/workflows/factory.factory.yml and contains 'merge it by hand'.
- 2026-11-22 18:13 6. Update the workflow assertions in the existing test '--force backs up what it replaces, and never resets waivers or evidence' to the new behaviour. factory.yml stays equal to the earlier version, factory.factory.yml contains 'gate: build', and no factory.yml.bak exists. Keep its profile, waiver and evidence assertions as they are. This changes an existing test, so the runtime will ask a person.
- 2026-11-22 18:13 7. Add .changeset/init-keeps-factory-yml.md with '@arynbht/factory': patch. It says that init, with or without --force, no longer replaces a factory.yml that differs from the template: it writes the template beside it as factory.factory.yml to merge by hand and then delete.
- 2026-11-22 18:13 8. Run pnpm action:build and keep any rebuilt packages/action/dist. Then run pnpm run lint, pnpm run typecheck and pnpm run test, and fix any failures. In particular, the factory/no-writes-to-workflows lint rule must still pass for init.ts through its allow-list.

## Decisions

- 2026-11-22 05:34 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/cli/src/commands/init.test.ts))
- 2026-11-22 05:34 under the threshold, for the approver: workflow
- 2026-11-22 05:34 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-22 18:16 flagged: protected_path: packages/cli/src/commands/init.test.ts — modifies a test that existed at base
- 2026-11-22 18:16 asked: secret: packages/action/dist/index.js adds a line that looks like a secret
- 2026-11-22 18:25 answered: allowed — test edit approved: assertions encode the old --force behaviour the card changes; dist secret is a false positive from the regenerated bundle
