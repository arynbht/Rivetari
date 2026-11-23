# T-0011 · Let diff.markdown-in-card skip generated docs and changesets

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 01:34 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 01:34 intake: intake confirmed; card sha256 317c665f5962b0d1e8cc1fe3ea86e15486a619513f4a505eebf135ba12e3a4d0 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 01:34 route: assembly proposed; sha256 12728a4a30c378c110081cc5fe6da4b6dc5bcdb289807b1e84cd700c40e383f3; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 01:35 route: route approved; assembly sha256 12728a4a30c378c110081cc5fe6da4b6dc5bcdb289807b1e84cd700c40e383f3 (arynbht@gmail.com (--yes))
- 2026-11-23 01:35 isolate: worktree .worktrees/T-0011 · branch fix/t-0011 from origin/main (03bb3e56dc76) · port 5175 · db software_factory_dev_t0011 · env sha256 8b64cd2c648c0f34ef451d80ddfcc3922cd34b660eedd08cffcc09e2a0d71611 (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:36 build: build started · skills spine only · budget 8 steps / 60k ctx · 87 repo file(s) in context · 779518 tokens · $1.16 · 12 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:40 build: build done · commit d324295d87a9 · 11 file(s) this round · 3 decision(s) flagged for the PR (autonomy review-at-pr) · 3477564 tokens · $1.87 · 36 turns · `diff.markdown-in-card` no longer fails Markdown under `.changeset/` or under globs listed in a new optional `generated` field in the profile. An unnamed `README.md` still fails. The tests for these f (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:40 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:44 prove: proof passed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:44 judge: judge passed · round 1 · head d324295d87a9 · record sha256 35e97a7f1608956ba63e14a4ff4e32bad3f5a933be05f95cb360eaaee4b24d2a (factory judge (for arynbht@gmail.com))
- 2026-11-23 01:44 ship: draft PR opened: #182 https://github.com/arynbht/software-factory/pull/182 · fix/t-0011 at d324295d87a9 → main (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:52 close: worktree C:\Users\arynb\Documents\Projects\Software Factory - Dev\.worktrees\T-0011 kept: it couldn't be removed; remove it by hand · branch fix/t-0011 kept (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:52 close: ledger sealed · merged (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 01:36 1. In packages/catalog/src/profile.ts, add an optional top-level `generated: z.array(z.string().min(1)).optional()` to ProfileSchema. Add no doc comment, since diff.no-new-comments is on. No file under packages/catalog/schema/ needs to change: only control.schema.json is generated there, from ControlObjectSchema. In packages/catalog/src/profile.test.ts, add a new describe block. It checks that `generated: ["docs/catalog/**"]` parses and is kept, that a profile without it still loads with `generated` undefined, and that a non-array or an empty string is rejected (A1).
- 2026-11-23 01:36 2. In packages/runtime/src/judge/diff-rules.ts, export a constant for the paths the rule always skips (`.changeset/**`) and add a `generated?: readonly string[] | undefined` option to DiffRuleOptions, kept apart from the existing `generated` Set the suppression rule uses (name it e.g. `generatedGlobs`). In diffRules, build a picomatch matcher over `.changeset/**` plus those globs (dot: true). Drop Markdown entries that match it before the card-name check, so the rule only fails unnamed Markdown outside them.
- 2026-11-23 01:36 3. Pass the globs through. Add `generatedGlobs?: readonly string[] | undefined` to Tier1Options in packages/runtime/src/judge/tier1.ts and forward it in the `diffRules(diff, added, {...})` call. In packages/runtime/src/judge/task-judge.ts, pass `generatedGlobs: repoProfile?.generated` next to `noNewComments`, from the profile it already loads.
- 2026-11-23 01:36 4. In packages/runtime/src/agent/rules.ts, extend the `diff.markdown-in-card` extra text so the line also names what it skips, using the same exported constant and `profile?.generated`. Example: `(the card names: …; Markdown under .changeset/ and the profile's generated paths docs/catalog/** is skipped)`, with the generated part left out when the profile has none.
- 2026-11-23 01:36 5. Two existing tests assert the old behaviour, so updating them is the only way the change can pass; the runtime will ask a person about it after the round. In diff-rules.test.ts, the 'fails Markdown the card doesn't name' case expects an unnamed `.changeset/fix.md` to fail; change its expected message to only `docs/notes.md`. In rules.test.ts, the first case asserts the exact markdown-in-card line; update it to the new line. tier1.test.ts's NOTES.md case stays as it is.
- 2026-11-23 01:36 6. Add new tests, each in a new `it`. In diff-rules.test.ts (A2): a change whose only unnamed Markdown is `docs/catalog/x.md`, with `generatedGlobs: ["docs/catalog/**"]`, plus `.changeset/y.md`, passes; the same change plus an unnamed `README.md` fails, naming only README.md. In rules.test.ts (A3): a profile with `generated:\n  - docs/catalog/**\n` gives a markdown-in-card line that names `.changeset/` and `docs/catalog/**`. Then run `pnpm vitest related --run` on the touched source and test files, after building the workspace packages if the runtime tests need the built catalog.
- 2026-11-23 01:36 7. Run `pnpm run lint` and `pnpm run typecheck` on the touched packages, then `pnpm action:build`, because catalog and runtime/src changed. Commit the rebuilt packages/action/dist/ with the change.
- 2026-11-23 01:36 8. Add the changeset .changeset/markdown-in-card-generated.md: `@arynbht/factory-catalog` minor and `@arynbht/factory-runtime` minor. One plain paragraph: the profile takes an optional `generated` list of globs; diff.markdown-in-card skips Markdown under those and under `.changeset/`; the build prompt's line for the rule names what it skips. Leave this repo's .factory/profile.yml alone (out of scope).

## Decisions

- 2026-11-23 01:34 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); "docs" in the title; skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/**/*.test.ts))
- 2026-11-23 01:34 under the threshold, for the approver: workflow
- 2026-11-23 01:34 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 01:40 flagged: protected_path: packages/catalog/src/profile.test.ts — modifies a test that existed at base
- 2026-11-23 01:40 flagged: protected_path: packages/runtime/src/agent/rules.test.ts — modifies a test that existed at base
- 2026-11-23 01:40 flagged: protected_path: packages/runtime/src/judge/diff-rules.test.ts — modifies a test that existed at base

## Proof

- 2026-11-23 01:44 tests failed on the change and on the base: pre-existing, not blamed on this change (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/catalog/src/profile.test.ts: accepts an optional list of generated globs and keeps it; packages/catalog/src/profile.test.ts: still loads a profile without it; packages/catalog/src/profile.test.ts: rejects a list that isn't one, or an empty glob; packages/runtime/src/agent/rules.test.ts: names the paths diff.markdown-in-card skips: .changeset/ and the profile's generated globs; packages/runtime/src/judge/diff-rules.test.ts: skips Markdown under the profile's generated globs and .changeset/, but not an unnamed README.md
- 2026-11-23 01:44 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-origin-18SEae'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯[22m[39m
- 2026-11-23 01:44 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0011/test-run.txt?raw=true

## Judge

- 2026-11-23 01:44 tier 1 round 1: pass · 7/9 pass · 2 pre-existing
- 2026-11-23 01:44 protected: packages/catalog/src/profile.test.ts — modifies a test that existed at base (allowed at build)
- 2026-11-23 01:44 protected: packages/runtime/src/agent/rules.test.ts — modifies a test that existed at base (allowed at build)
- 2026-11-23 01:44 protected: packages/runtime/src/judge/diff-rules.test.ts — modifies a test that existed at base (allowed at build)
- 2026-11-23 01:44 review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 2064 tokens · $0.12
- 2026-11-23 01:44 acceptance A1: met — `generated` is an optional array of non-empty strings. profile.test.ts covers parsing with it, loading without it, and rejecting bad values.
- 2026-11-23 01:44 acceptance A2: met — diff-rules.test.ts passes docs/catalog/x.md (generated glob) and .changeset/y.md, and still fails an unnamed README.md.
- 2026-11-23 01:44 acceptance A3: met — rules.test.ts checks that the rule line names .changeset/ alone, and .changeset/ plus the profile's generated globs.
- 2026-11-23 01:44 judge review posted: https://github.com/arynbht/software-factory/pull/182#pullrequestreview-6015707817

## Outcome

- 2026-11-23 01:52 PR #182 merged by arynbht 2026-11-23 01:52 · 18m · 4259k tokens · $3.15
