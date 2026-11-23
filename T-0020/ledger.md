# T-0020 · Record risk and prompt size in history, and flag low-risk cards over $1 in metrics

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 07:48 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 07:48 intake: intake confirmed; card sha256 ec82a72196575c140bf1a68e3e3d97879faf853643973d72323c078db7247e68 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:48 route: assembly proposed; sha256 a60c5ace76252086c09215efa6fdb9c4d8134b87023c688aa5b1316f5e64ac8f; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 07:48 route: route approved; assembly sha256 a60c5ace76252086c09215efa6fdb9c4d8134b87023c688aa5b1316f5e64ac8f (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:49 isolate: worktree .worktrees/T-0020 · branch feature/t-0020 from origin/main (c9312b59748c) · port 5175 · db rivetari_t0020 · env sha256 e1f662c3279d919958b885c35d3af3e25ed21591525113034819fdd7f7365e87 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:49 build: build started · skills spine only · budget 8 steps / 60k ctx · 4 repo file(s) in context · 267291 tokens · $0.36 · 12 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:53 build: build done · commit 5d18b4f22787 · 7 file(s) this round · 1372799 tokens · $0.95 · 38 turns · I've finished all three acceptance criteria. Lint, typecheck and the format check pass, and the 35 tests related to the changed files (including the new ones) pass. Running only those tests trips the (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:53 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:10 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:10 judge: judge passed · round 1 · head 5d18b4f22787 · record sha256 d6c5ae00eca79a05ec9272f142edd022c7faec6908aee14977f67efb6d1d3846 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 08:10 ship: draft PR opened: #192 https://github.com/arynbht/Rivetari/pull/192 · feature/t-0020 at 5d18b4f22787 → main (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:24 close: worktree removed · branch feature/t-0020 deleted (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:24 close: ledger sealed · merged (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 07:49 1. In packages/runtime/src/ship/close.ts, add optional `risk?: "low" | "medium" | "high"` and `prompt_tokens?: number` fields to TaskHistoryRow. Do not touch USAGE_AT or usageTotals, so the token and cost totals stay as they are.
- 2026-11-23 07:49 2. In close.ts, add an exported `promptTokens(task: Task): number | undefined`. It reads only build-beat timeline entries whose text starts with `build started` (both the full-path and the fast-path lines). It collects every `~(\d+(?:,\d+)*) prompt tokens` match, allowing for an optional k suffix in case #189 writes `~12k`, and returns the largest figure, or undefined when no line has one.
- 2026-11-23 07:49 3. In closeTask, set `risk: task.card.risk` on the row (the card schema defaults it to medium). Add `prompt_tokens` only when promptTokens returns a number, using a conditional spread so the key is left out of the JSON otherwise. The written-row dedupe check stays unchanged.
- 2026-11-23 07:49 4. Add packages/runtime/src/ship/history-cost.test.ts, reusing the repo, task and close fixture approach from ship.test.ts (a proved task closed with --abandon, then the .rivetari/history.jsonl row read back). Cover A1: a low-risk card whose ledger has build-started lines with ~1200 and ~4800 prompt tokens gives `risk: low` and `prompt_tokens: 4800`, and a task with no such line has no prompt_tokens key. Also add pure promptTokens cases that check agent text on build-done lines is ignored.
- 2026-11-23 07:49 5. In packages/cli/src/commands/metrics.ts, add an exported `costFlags(rows: TaskHistoryRow[])` that keeps rows with `risk === "low"` and `cost_usd > 1`. Rows with no risk are never kept (A3). Add an exported `renderCost(rows)` that prints a `Cost` header, then one line per flagged row with the task id, `$cost_usd.toFixed(2)` and prompt_tokens (or n/a), or `  none: no low-risk task cost over $1` when nothing is flagged. Get the rows from `historyRows(root)`, which @arynbht/rivetari-runtime already exports; import the TaskHistoryRow type from there too.
- 2026-11-23 07:49 6. Wire the cost section into runMetrics. Append renderCost to both text outputs (the --findings path, which needs no GitHub, and the full DORA path), and add a `cost` key to both JSON outputs. Leave the existing sections and their order alone so metrics.test.ts keeps passing unchanged.
- 2026-11-23 07:49 7. Add packages/cli/src/commands/metrics-cost.test.ts, following the tmp dir and stdout spy pattern from metrics.test.ts, using runMetrics(dir, { findings: true }, { token: null }). Cover A2: a low-risk row at cost_usd 1.40 with prompt_tokens is listed with id, cost and prompt tokens, while a low-risk row at 0.80 and a medium-risk row at 3.00 are not, and a history with no flagged rows prints the none line. Cover A3: a row with cost_usd 5 and no risk field is not listed. Add unit cases for costFlags and renderCost directly.
- 2026-11-23 07:49 8. Add .changeset/history-cost.md with minor bumps for @arynbht/rivetari-runtime and @arynbht/rivetari. Run `pnpm action:build` and commit the rebuilt packages/action/dist. Run `pnpm vitest related --run` on close.ts, metrics.ts and the two new test files after the build, then `pnpm run lint` and `pnpm run typecheck`. Check the diff has no new comments and no edits to existing tests.

## Decisions

- 2026-11-23 07:48 routed to docs, testing, observability: docs (touches **/*.md (.changeset/history-cost.md); skill native-writing triggers on **/*.md (.changeset/history-cost.md)), testing (touches **/*.test.* (packages/runtime/src/ship/history-cost.test.ts)), observability ("metrics" in the title)
- 2026-11-23 07:48 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 08:10 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/metrics-cost.test.ts: lists a low-risk task over $1 with its id, cost and prompt tokens; packages/cli/src/commands/metrics-cost.test.ts: says so plainly when no low-risk task cost over $1; packages/cli/src/commands/metrics-cost.test.ts: never flags a row written before risk was recorded; packages/cli/src/commands/metrics-cost.test.ts: flags only low-risk rows strictly over $1, and renders a missing prompt size as n/a; packages/runtime/src/ship/history-cost.test.ts: records the card's risk and the largest prompt figure on build-started lines; packages/runtime/src/ship/history-cost.test.ts: leaves prompt_tokens out when no build-started line carries a figure; packages/runtime/src/ship/history-cost.test.ts: reads only the runtime's build-started lines, never an agent's summary; packages/runtime/src/ship/history-cost.test.ts: reads a k figure, and gives undefined when no line has one
- 2026-11-23 08:10 output: … increase limit (node:42520) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:42520) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 08:10 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0020/test-run.txt?raw=true

## Judge

- 2026-11-23 08:10 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 08:10 review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 2202 tokens · $0.13
- 2026-11-23 08:10 acceptance A1: met — closeTask writes risk from task.card.risk and prompt_tokens from the largest '~N prompt tokens' figure on build-started timeline lines, and omits prompt_tokens when no line has one. history-cost.test.…
- 2026-11-23 08:10 acceptance A2: met — renderCost lists low-risk rows with cost_usd > 1 by id, cost and prompt_tokens, and prints a 'none:' line when there are none. metrics-cost.test.ts covers both through runMetrics and directly.
- 2026-11-23 08:10 acceptance A3: met — costFlags requires risk === 'low', so rows without risk are never flagged. Tested with T-0009 at $5 and T-0004 at $9.
- 2026-11-23 08:10 judge review posted: https://github.com/arynbht/Rivetari/pull/192#pullrequestreview-6018320583

## Outcome

- 2026-11-23 08:24 PR #192 merged by arynbht 2026-11-23 08:24 · 36m · 1642k tokens · $1.44
