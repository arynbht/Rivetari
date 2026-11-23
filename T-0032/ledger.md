# T-0032 · Route a Markdown-only card on its touches, not its wording

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 23:12 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 23:12 intake: intake confirmed; card sha256 dc9d321ded6cb3b84ae0e6be36113d57d891df9b1a2b4374480859ff3134b8fe (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 23:12 route: assembly proposed; sha256 a5dedfbd8bfa82fbaa5097ca5f7c38f6527caeb93ea2e4eb3668d020d1c69e01; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 23:12 route: route approved; assembly sha256 a5dedfbd8bfa82fbaa5097ca5f7c38f6527caeb93ea2e4eb3668d020d1c69e01 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 23:13 isolate: worktree .worktrees/T-0032 · branch fix/t-0032 from origin/main (31821c83434a) · port 5175 · db rivetari_t0032 · env sha256 2d131e2dcf15c63573aca59c945decc744054642520fb5139d8e9d5942244e2b (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:13 build: build started · fast path (low risk, 2 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 15k ctx (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:21 build: build done · commit 3547bd8abb1e · 3 file(s) this round · 520191 tokens · $0.51 · 15 turns · A card whose touches are all Markdown no longer gets the ui sector or the browser proof just from its wording. Cards with any other touch, or with no touches, route exactly as before. The 29 test file (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:21 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:47 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:47 judge: judge passed · round 1 · head 3547bd8abb1e · record sha256 33966259b38df7b93464d95b0bc1a2b82bda83dd33e49897787f20aa8802f376 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 23:47 ship: draft PR opened: #234 https://github.com/arynbht/Rivetari/pull/234 · fix/t-0032 at 3547bd8abb1e → main (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 23:13 1. A1: route() for a card whose only touch is a root Markdown file, with front-end keywords in its description, doesn't put the front-end sector in and its proof isn't the browser proof
- 2026-11-23 23:13 2. A2: a card touching docs/guide.md and src/app/main.ts with the same description routes as now
- 2026-11-23 23:13 3. A3: a card with no touches and the same description routes as now

## Decisions

- 2026-11-23 23:12 risk low: no high or medium signal in the touches
- 2026-11-23 23:12 routed to docs, testing: docs (touches **/*.md (.changeset/docs-only-ui.md); "docs" in the description; "documentation" in the description; skill native-writing triggers on **/*.md (.changeset/docs-only-ui.md)), testing (touches **/*.test.* (packages/runtime/src/router/docs-only-ui.test.ts); "test" in the description)
- 2026-11-23 23:12 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 23:47 tests passed (npm test -- packages/runtime/ apps/desktop/ packages/action/ packages/cli/ --passWithNoTests --coverage.enabled=false, exit 0, in the judge's tier 1 run on the change) · new tests: packages/runtime/src/router/docs-only-ui.test.ts: doesn't bring in ui or the browser proof on its wording; packages/runtime/src/router/docs-only-ui.test.ts: ignores ui words in the title too, and docs/ paths count as docs; packages/runtime/src/router/docs-only-ui.test.ts: routes ui in on the same wording when it also touches code; packages/runtime/src/router/docs-only-ui.test.ts: routes ui in on the same wording when it has no touches
- 2026-11-23 23:47 output: … increase limit (node:42300) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:42300) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 23:47 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0032/test-run.txt?raw=true

## Judge

- 2026-11-23 23:47 tier 1 round 1: pass · 8/8 pass
- 2026-11-23 23:47 tier 1 note: checked packages/runtime, apps/desktop, packages/action, packages/cli only: the change touches packages/runtime, and apps/desktop, packages/action, packages/cli depend on it
- 2026-11-23 23:47 tier 1 note: quality.boundaries.clean, quality.lint.clean, quality.typecheck.clean ran on every package: their scripts can't be narrowed to packages
- 2026-11-23 23:47 tier 1 note: quality.coverage.floor not checked: the tests ran for the affected packages only, and part of the suite can't be held to the whole repo's floor; it runs with the full suite
- 2026-11-23 23:47 review round 1: approve; 0 blocking, 1 suggestion(s) (claude-sonnet-5-5) · 11482 tokens · $0.06
- 2026-11-23 23:47 acceptance A1: met — The first test in docs-only-ui.test.ts routes a card touching only README.md with front-end wording and asserts ui is absent and the proof is not ui-screenshots.
- 2026-11-23 23:47 acceptance A2: met — The test routes docs/guide.md plus src/app/main.ts and asserts ui, a11y and ui-screenshots. It checks the outcome, not equality with the old routing, but it is adequate.
- 2026-11-23 23:47 acceptance A3: met — The test routes a card with empty touches and asserts ui, a11y and ui-screenshots. `docsOnly` requires a non-empty touch list, so this card routes as before.
- 2026-11-23 23:47 judge review posted: https://github.com/arynbht/Rivetari/pull/234#pullrequestreview-6031358738
- 2026-11-23 23:47 judge check not posted (ship goes on): Resource not accessible by integration - https://docs.github.com/rest/checks/runs#create-a-check-run
