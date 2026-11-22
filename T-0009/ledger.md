# T-0009 · Skip generated files when looking for new check suppressions

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-22 21:45 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-22 21:46 intake: intake confirmed; card sha256 0d352309a3e5ccb35c0372d87ca0e08dc706e90246bb18a9bcf3a871c5dffb79 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 21:46 route: assembly proposed; sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-22 21:46 route: route approved; assembly sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c (arynbht@gmail.com (--yes))
- 2026-11-22 21:46 isolate: worktree .worktrees/T-0009 · branch fix/t-0009 from origin/main (ac2b17f69f6c) · port 5174 · db software_factory_dev_t0009 · env sha256 03a32bdd0f6da3689658a57c79819c6cf56bad43ec3b70b3b030d00a4289c2a5 (factory runtime (for arynbht@gmail.com))
- 2026-11-22 21:47 build: build started · skills spine only · budget 8 steps / 60k ctx · 54 repo file(s) in context · 783905 tokens · $0.99 · 10 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-22 21:54 build: build paused: 2 thing(s) to ask about · commit 59582d368250 · 3140684 tokens · $1.86 · 41 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-22 22:03 prove: proof passed · test-run (factory runtime (for arynbht@gmail.com))
- 2026-11-22 22:09 judge: judge failed · round 1 · head 59582d368250 · tier 1 failed · record sha256 f239c6ea0fce9f4d0671f1d49218c8c0554013d3e832b5a89dc24e2ac2801c60 (factory judge (for arynbht@gmail.com))
- 2026-11-22 22:13 build: build paused: 1 thing(s) to ask about · commit 6073273c900c · 1124303 tokens · $0.90 · 40 turns · retry (factory runtime (for arynbht@gmail.com))
- 2026-11-22 22:22 prove: proof failed · test-run (factory runtime (for arynbht@gmail.com))
- 2026-11-22 22:29 build: build paused: 1 thing(s) to ask about · commit 6073273c900c · 215210 tokens · $0.28 · 7 turns · retry (factory runtime (for arynbht@gmail.com))
- 2026-11-22 22:34 build: build paused: 1 thing(s) to ask about · commit 6073273c900c · 127258 tokens · $0.20 · 4 turns · retry (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-22 21:47 1. Move GENERATED, isGeneratedPath and generatedPaths from packages/runtime/src/judge/tier2.ts into packages/runtime/src/judge/protected.ts, unchanged, and have tier2.ts import them from protected.js and re-export them. tier1 can't import from tier2: tier2 already imports parseNameStatus from tier1, and .dependency-cruiser.mjs has a no-circular rule. tier2.ts isn't named in the card's touches, so mention that in the PR.
- 2026-11-22 21:47 2. In protected.ts, give findProtected an optional fourth parameter `generated: ReadonlySet<string>` and skip the SUPPRESSION scan of added lines for those paths. Path-based findings (factory state, lint and CI config, existing tests, scripts) stay as they are. Update the doc comment to say why: a rebuilt bundle re-adds minified lines that carry the runtime's own suppression pattern.
- 2026-11-22 21:47 3. In diff-rules.ts, add a `generated?: ReadonlySet<string>` option to DiffRuleOptions and drop lines from those paths in suppressionHits, next to the allowedSuppressions filter. Source files and test files that aren't generated are still checked for suppressions and skipped tests.
- 2026-11-22 21:47 4. In agent/stops.ts, import generatedPaths from ../judge/protected.js. Compute `generated` once from [...added.keys()] before the findProtected call, pass it to findProtected, and reuse it in the secret loop that follows so there's one lookup and one comment.
- 2026-11-22 21:47 5. In judge/tier1.ts runTier1, after parseAddedLines, compute generatedPaths(repo, [...added.keys()]) from protected.js. Pass it to findProtected, which then doesn't make the verdict needs-human for a suppression in a generated file, and as the `generated` option to diffRules for diff.no-new-suppressions.
- 2026-11-22 21:47 6. Add new test files only; existing ones like agent.test.ts and protected.test.ts are protected. packages/runtime/src/agent/stops.test.ts runs findStops on a temp git repo with a minimal assembly (stop_and_ask: []). A1: an added `// eslint-disable-next-line` in packages/action/dist/index.js gives no protected_path stop. A3: the same line in src/a.ts gives a protected_path stop with reason suppression. A linguist-generated file listed in .gitattributes is skipped too.
- 2026-11-22 21:47 7. Add packages/runtime/src/judge/generated-suppressions.test.ts. A2: diffRules passes diff.no-new-suppressions when the only suppression-shaped line is in a path in `generated`, and findProtected with the same set returns no suppression finding. A3: an eslint-disable in src/b.ts still fails diff.no-new-suppressions and still gives a suppression finding. Add a .changeset/generated-suppressions.md patch for @arynbht/factory-runtime that explains the T-0008 stop. Run `pnpm action:build` and commit the rebuilt packages/action/dist.
- 2026-11-22 21:47 8. Run pnpm run lint, pnpm run typecheck, pnpm run test (at least the runtime package) and the boundaries check, so no-circular confirms the move broke the tier1/tier2 cycle. Fix anything new that fails, then confirm git diff stays within the card's touches plus tier2.ts.

## Decisions

- 2026-11-22 21:46 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/**/*.test.ts))
- 2026-11-22 21:46 under the threshold, for the approver: security
- 2026-11-22 21:46 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-22 21:54 asked: protected_path: packages/action/dist/index.js — adds a check suppression: `)}`]}var VG=ue(fn(),1);var t0=ue(fn(),1),mt={factoryState:[".factory/**"],skillRegistry:[".factory/skills.lock",".facto
- 2026-11-22 21:54 asked: protected_path: packages/runtime/src/agent/stops.test.ts — adds a check suppression: it("still stops for an eslint-disable added in a source file", async () => {
- 2026-11-22 21:55 answered: allowed — pre-authorised by the owner: dist line is the regenerated bundle; the only source match is the A3 test's title naming eslint-disable, not a suppression (bug: the pattern matches suppression names inside strings)
- 2026-11-22 22:13 asked: protected_path: packages/action/dist/index.js — adds a check suppression: `)}`]}var BG=ue(qr(),1);var RG=ue(qr(),1),mt={factoryState:[".factory/**"],skillRegistry:[".factory/skills.lock",".facto
- 2026-11-22 22:13 answered: allowed — pre-authorised by the owner: the regenerated bundle again; source adds no suppression
- 2026-11-22 22:29 asked: agent_question: The proof failed only on the store.test.ts lease test, which isn't part of this change. It timed out under full-suite load on Windows, passes on its own in 7.4s, and passed when I re-ran the full suite (748/748). Should the test-run proof just be re-run on this change as it is, or do you want that test's timing fixed in a separate task first?
- 2026-11-22 22:33 answered: allowed — owner: re-run the proof on the same commit; the failure is the known store.test.ts lease flake under full-suite load on Windows (bug 4), not this change
- 2026-11-22 22:34 asked: no_change: I made no changes this round. You asked for the proof to be re-run on the same commit (`6073273`), so I left the worktree as it was: clean, with nothing new to commit. Before your answer I tried to re-run this task's two new test files directly. That attempt failed before running any tests: I gave the file paths relative to the runtime package, and the test config looks for them from the repo root, so it found no test files. My second attempt, from the repo root, was refused permission. So I hav…
- 2026-11-22 22:35 answered: allowed — owner: no change is right; re-prove commit 6073273 (bug-4 flake)

## Proof

- 2026-11-22 22:03 tests failed on the change and on the base: pre-existing, not blamed on this change (pnpm run test, exit 1) · new tests: packages/runtime/src/agent/stops.test.ts: doesn't stop for a suppression-shaped line in the action's bundle; packages/runtime/src/agent/stops.test.ts: doesn't stop for one in a file .gitattributes marks linguist-generated; packages/runtime/src/agent/stops.test.ts: still stops for an eslint-disable added in a source file; packages/runtime/src/judge/generated-suppressions.test.ts: passes diff.no-new-suppressions and isn't protected when the only one is in a generated path; packages/runtime/src/judge/generated-suppressions.test.ts: still fails one added in a source file; packages/runtime/src/judge/generated-suppressions.test.ts: checks a dist file no one said was generated
- 2026-11-22 22:03 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-BBjykQ'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯[22m[39m
- 2026-11-22 22:03 evidence: the test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0009/test-run.txt?raw=true
- 2026-11-22 22:22 tests failed (pnpm run test, exit 1) · new tests: packages/runtime/src/agent/stops.test.ts: doesn't stop for a suppression-shaped line in the action's bundle; packages/runtime/src/agent/stops.test.ts: doesn't stop for one in a file .gitattributes marks linguist-generated; packages/runtime/src/agent/stops.test.ts: still stops for an eslint-disable added in a source file; packages/runtime/src/judge/generated-suppressions.test.ts: passes diff.no-new-suppressions and isn't protected when the only one is in a generated path; packages/runtime/src/judge/generated-suppressions.test.ts: still fails one added in a source file; packages/runtime/src/judge/generated-suppressions.test.ts: checks a dist file no one said was generated
- 2026-11-22 22:22 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-dJkF4I'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯[22m[39m
- 2026-11-22 22:22 evidence: the test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0009/test-run.txt?raw=true

## Judge

- 2026-11-22 22:09 tier 1 round 1: fail · 6/9 pass · 2 pre-existing · 1 fail
- 2026-11-22 22:09 tier 1 fail: diff.no-new-comments — new comments: packages/runtime/src/agent/stops.test.ts: // The protected-path stop on suppressions: a rebuilt bundle re-adds lines that; packages/runtime/src/agent/stops.test.ts: // carry the runtime's own suppression pattern, so generated files are skipped; packages/runtime/src/agent/stops.test.ts:…
- 2026-11-22 22:09 protected: packages/action/dist/index.js — adds a check suppression: `)}`]}var VG=ue(fn(),1);var t0=ue(fn(),1),mt={factoryState:[".factory/**"],skillRegistry:[".factory/skills.lock",".facto (allowed at build)
- 2026-11-22 22:09 protected: packages/runtime/src/agent/stops.test.ts — adds a check suppression: it("still stops for an eslint-disable added in a source file", async () => { (allowed at build)
