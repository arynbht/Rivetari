# T-0017 · Cap the build prompt's slice and the plan call

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 06:52 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 06:52 intake: intake confirmed; card sha256 7ac5f3a145f8bb2d076b5916de1c1b6eb75e2e7cd44202b91654662e0ca44b52 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 06:52 route: assembly proposed; sha256 4036a62b8f487bff9407803a805e98391415f48e859ec26b4f26b8220aa9a63b; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 06:53 route: assembly proposed; sha256 4036a62b8f487bff9407803a805e98391415f48e859ec26b4f26b8220aa9a63b; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 06:53 route: route approved; assembly sha256 4036a62b8f487bff9407803a805e98391415f48e859ec26b4f26b8220aa9a63b (arynbht@gmail.com (--yes))
- 2026-11-23 06:54 isolate: worktree .worktrees/T-0017 · branch fix/t-0017 from origin/main (9ac4aca420d0) · port 5174 · db rivetari_t0017 · env sha256 168cfc440abbde3a069fbba4e8fe4512c43a4180548457a0ddf17952a6aa00ac (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 06:54 build: build started · skills spine only · budget 12 steps / 60k ctx · 51 repo file(s) in context · 438917 tokens · $0.56 · 11 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 06:59 build: build done · commit 2f98aff3d5a1 · 7 file(s) this round · 2449302 tokens · $1.59 · 39 turns · The build and plan prompts now get a capped slice instead of every file the touches globs match. The plan call runs in plan mode with a 4-turn limit, and the build-start ledger line records the prompt (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 06:59 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:17 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:18 judge: judge passed · round 1 · head 2f98aff3d5a1 · record sha256 925f436e3b6ad13c55a964e54c92387d66dec975c321bf9a928fb07768689ac0 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 07:18 ship: draft PR opened: #189 https://github.com/arynbht/Rivetari/pull/189 · fix/t-0017 at 2f98aff3d5a1 → main (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:09 close: worktree removed · branch fix/t-0017 kept (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:09 close: ledger sealed · closed (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 06:54 1. Add packages/runtime/src/agent/slice.ts exporting `capSlice(worktree, card): Promise<string[]>`. It starts from the card's source touches (reuse `sourceTouches` from judge/fast-path.ts) and drops any touch that is a test file (`*.test.*` or `*.spec.*`), so a test glob like `packages/**/*.test.ts` is never expanded. Expand the remaining source globs against the worktree and drop `isGeneratedPath` matches.
- 2026-11-23 06:54 2. In slice.ts, for each touched source file, read it and collect its direct relative imports and re-exports (`import … from './x'`, `export … from '../y'`, dynamic `import('./z')`). Ignore any specifier that doesn't start with `.`, so bare packages are never followed. Resolve each one to an existing repo file, mapping `.js` to `.ts`/`.tsx`/`.mts`, trying the extension-less form and `index.*`. Go one level only: imported files are never scanned for their own imports.
- 2026-11-23 06:54 3. In slice.ts, add the sibling test files of each touched source only: `<name>.test.<ext>`, `<name>.spec.<ext>`, and any `<name>*.test.<ext>` in the same directory that exists. Don't add tests for the imported files. Return README.md plus touches, imports and tests, deduplicated, sorted and with the CONTRACT_DOCS excluded.
- 2026-11-23 06:54 4. In prompt.ts, replace the `sliceGlobs(card)` call in `assemblePrompt` with `capSlice(isolation.worktree, card)`, passed to packContext as literal paths. Keep `sliceGlobs` exported (index.ts re-exports it) but have it no longer expand test globs, or make it delegate to the same rules. Add `approxTokens: number` to `AssembledPrompt`, computed as `Math.ceil(prompt.length / 4)` over the full assembled prompt.
- 2026-11-23 06:54 5. In build.ts, add an optional `maxTurns?: number` to `AgentCall`. In `claudeAgent`, append `--max-turns <n>` when it is set, and give plan mode `--permission-mode plan` alongside READ_ONLY_TOOLS. Add a `PLAN_TURNS = 4` constant and pass `maxTurns: PLAN_TURNS` on the plan call. The plan call already uses `assemblePrompt`, so it gets the same capped slice.
- 2026-11-23 06:54 6. In build.ts, change the build-start ledger line to put the size before the file count, for example `· ~${planning.approxTokens} prompt tokens · ${planning.files.length} repo file(s) in context${usageNote(reply)}`. The `~N prompt tokens` wording keeps close.ts's USAGE_AT regex (`.* repo file\(s\) in context${USAGE}$`) matching and doesn't collide with the ` · N tokens` usage note. Give the fast-path build-start line the same treatment only if that is cheap; otherwise leave it.
- 2026-11-23 06:54 7. Add packages/runtime/src/agent/slice-cap.test.ts for A1 and A2. Build a temp repo with packages/runtime/src/judge/diff-rules.ts importing `./diff-helpers.js`, `../task/card.js` and a bare `zod`. diff-helpers.ts imports `./deeper.js`. diff-rules.test.ts sits beside diff-rules.ts, plus unrelated tests elsewhere (packages/engine/src/x.test.ts, packages/runtime/src/judge/other.test.ts). Assert that `capSlice` (and `assemblePrompt().files` via a minimal isolation) returns exactly diff-rules.ts, its two relative imports and diff-rules.test.ts. Assert that deeper.ts, zod and the unrelated tests are absent.
- 2026-11-23 06:54 8. In slice-cap.test.ts, cover A3 and A4 with a scripted AgentRunner through `buildTask` on a routed, isolated task, using the same setup pattern as agent.test.ts in a new file. Assert that the plan call has `maxTurns === 4` and that its prompt's `### ` file headers equal the build call's. Assert that the `build started` ledger line contains `~<n> prompt tokens` next to `<m> repo file(s) in context`. Add a small unit test that `claudeAgent`'s argv construction includes `--max-turns 4` and `--permission-mode plan` for plan mode. If argv isn't reachable, extract a pure `agentArgs(call)` helper in build.ts and test that.
- 2026-11-23 06:54 9. Run `pnpm vitest related --run packages/runtime/src/agent/slice.ts packages/runtime/src/agent/prompt.ts packages/runtime/src/agent/build.ts packages/runtime/src/agent/slice-cap.test.ts` and fix failures. Check that the existing agent.test.ts (`### src/total.ts` in the prompt) and the ship.test.ts ledger expectations still pass unchanged. Then run `pnpm run typecheck` and `pnpm run lint`, and make sure no new code comments or suppressions were added.
- 2026-11-23 06:54 10. Run `pnpm action:build` and keep the regenerated packages/action/dist/ in the change. Add .changeset/cap-build-slice.md with a `@arynbht/rivetari-runtime` patch entry. It should say the slice is now touched sources plus their direct relative imports plus sibling tests only, test globs are no longer expanded, the plan call is capped at 4 turns in plan mode, and the build-start line records approximate prompt tokens.

## Decisions

- 2026-11-23 06:52 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/agent/slice-cap.test.ts); "test" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 06:52 under the threshold, for the approver: observability
- 2026-11-23 06:52 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 06:53 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/agent/slice-cap.test.ts); "test" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 06:53 under the threshold, for the approver: observability
- 2026-11-23 06:53 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 07:17 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/runtime/src/agent/slice-cap.test.ts: is the touched source, its relative imports and its own tests, never a test glob's matches; packages/runtime/src/agent/slice-cap.test.ts: follows relative imports one level and never a bare package; packages/runtime/src/agent/slice-cap.test.ts: reads import, export, dynamic import and require specifiers, relative only; packages/runtime/src/agent/slice-cap.test.ts: resolves an extension-less import and a directory index; packages/runtime/src/agent/slice-cap.test.ts: plans on the same capped slice as the build, within the turn limit, and logs the prompt's size; packages/runtime/src/agent/slice-cap.test.ts: runs the plan call in plan mode with --max-turns, and the build without a turn limit
- 2026-11-23 07:17 output: … increase limit (node:40108) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:40108) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 07:17 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0017/test-run.txt?raw=true

## Judge

- 2026-11-23 07:17 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 07:18 review round 1: approve; 0 blocking, 5 suggestion(s) (claude-opus-5-5) · 8572 tokens · $0.28
- 2026-11-23 07:18 acceptance A1: met — slice-cap.test.ts asserts capSlice for diff-rules.ts plus packages/**/*.test.ts equals diff-rules.ts, its two relative imports and diff-rules.test.ts, with other.test.ts and the engine tests excluded.
- 2026-11-23 07:18 acceptance A2: met — The test asserts diff-helpers.ts and card.ts are in, deeper.ts is out and nothing from zod is in. relativeImports skips bare and node: specifiers.
- 2026-11-23 07:18 acceptance A3: met — The buildTask test checks that the plan and build prompts carry the same SLICE headers and that plan maxTurns is PLAN_TURNS (4). The agentArgs test checks for --max-turns 4.
- 2026-11-23 07:18 acceptance A4: met — The build-started line includes '~N prompt tokens · M repo file(s) in context'. The test checks N equals ceil(prompt.length/4) and M equals the slice length in the ledger.
- 2026-11-23 07:18 judge review posted: https://github.com/arynbht/Rivetari/pull/189#pullrequestreview-6017764187

## Outcome

- 2026-11-23 22:09 PR #189 closed without merging · 15h16m · 2897k tokens · $2.43
