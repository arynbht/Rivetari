# T-0004 · Keep a customised factory.yml when init runs with --force

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-21 17:59 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-21 18:03 intake: intake confirmed; card sha256 39d700792dd810c6b1a5301e8dbe1a8084680b42da5e6f6e4d0d9c31d8d147fe (arynbht@gmail.com (--yes))
- 2026-11-21 18:03 route: assembly proposed; sha256 a30493cb320b4b072563334dfb202c42af92536fddff7bdf790c15883d2c3651; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-21 18:13 route: route approved; assembly sha256 a30493cb320b4b072563334dfb202c42af92536fddff7bdf790c15883d2c3651 (arynbht@gmail.com (--yes))
- 2026-11-21 18:14 isolate: worktree .worktrees/T-0004 · branch fix/t-0004 from origin/main (56dbe51268aa) · port 5174 · db software_factory_dev_t0004 · env sha256 192984c0d04a08778829c7f835ac17aad3d9c9077f4224851f7204b8debc5022 (factory runtime (for arynbht@gmail.com))
- 2026-11-21 18:15 build: build started · skills spine only · budget 8 steps / 60k ctx · 28 repo file(s) in context · 99894 tokens · $0.33 (factory runtime (for arynbht@gmail.com))
- 2026-11-21 18:20 build: build paused: 1 thing(s) to ask about · commit 3ca961966ee8 · 1119258 tokens · $0.87 (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-21 18:15 1. In packages/cli/src/commands/init.ts, write .github/workflows/factory.yml through writeBeside with force always false. That way a missing file is written from the template, an identical one is left alone, and a different one stays byte-for-byte unchanged while the template goes to .github/workflows/factory.factory.yml, with or without --force. Drop the workflow from the --force replace-and-backup path; AGENTS.md and the other §10 files keep it.
- 2026-11-21 18:15 2. Extend the factory.yml note returned in init.ts so it names .github/workflows/factory.factory.yml, says to merge it by hand, and warns that GitHub runs it and the catalog's factory.yml-only excludes count it, so it should be deleted after the merge. Update the doc comments on writeReplacing and writeBeside, and the §5.4 comment in runInit, to say that factory.yml is never replaced.
- 2026-11-21 18:15 3. Update the existing init.test.ts case '--force backs up what it replaces, and never resets waivers or evidence'. Its factory.yml assertions ('gate: build' plus factory.yml.bak) contradict A1, so they should check that factory.yml is unchanged and factory.factory.yml exists. Changing an existing test needs a person's approval, and the runtime will ask about it after the round.
- 2026-11-21 18:15 4. Add a test to init.test.ts for A1: write a customised factory.yml (for example a 'factory' check name and a local action), run init with --force, then check that factory.yml is byte-for-byte unchanged, factory.factory.yml equals a fresh init's template, and no factory.yml.bak exists. Also cover the same case without --force on a repo that has no profile.
- 2026-11-21 18:15 5. Add a test for A2: on repos with no factory.yml, run init once without --force and once with --force (no existing profile) and check that factory.yml is written from the template ('name: factory', 'gate: <phase>') and that no factory.factory.yml exists.
- 2026-11-21 18:15 6. Add a test for A3: spy on process.stdout.write, run init on a repo whose factory.yml differs, and check that the output names .github/workflows/factory.factory.yml and says to merge it by hand.
- 2026-11-21 18:15 7. Add .changeset/init-keeps-factory-yml.md with a patch bump for "@arynbht/factory". Describe the fix: init, with or without --force, keeps a factory.yml a person changed and writes the template beside it as factory.factory.yml.
- 2026-11-21 18:15 8. Run pnpm action:build and commit the rebuilt packages/action/dist/. Then run pnpm run lint, pnpm run typecheck and pnpm run test (at least the packages/cli init tests) and make sure all three pass with no new warnings.

## Decisions

- 2026-11-21 18:03 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/cli/src/commands/init.test.ts))
- 2026-11-21 18:03 under the threshold, for the approver: workflow
- 2026-11-21 18:03 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-21 18:20 asked: protected_path: packages/cli/src/commands/init.test.ts — modifies a test that existed at base
