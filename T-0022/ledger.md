# T-0022 · Decide keyword-only borderline sectors as not in, without holding the route

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 08:29 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 08:29 intake: intake confirmed; card sha256 c5184be1239ac5706a85c379de30d27532df959ed25931cbfa27125e79430733 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 08:29 route: assembly proposed; sha256 359184280655143ef45a32c4f94431a015b1350ff7f8272bc063bdee31de313e; skills none; proof infra-plan; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 08:30 route: assembly proposed; sha256 359184280655143ef45a32c4f94431a015b1350ff7f8272bc063bdee31de313e; skills none; proof infra-plan; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 08:30 route: route approved; assembly sha256 359184280655143ef45a32c4f94431a015b1350ff7f8272bc063bdee31de313e (arynbht@gmail.com (--yes))
- 2026-11-23 08:31 isolate: worktree .worktrees/T-0022 · branch fix/t-0022 from origin/main (2b401948e6b9) · port 5175 · db rivetari_t0022 · env sha256 c85d4c48a127861e8b87daf9f436b44ce0bac8eb84cafe6e5a8dc34228413886 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:31 build: build started · skills spine only · budget 12 steps / 60k ctx · 7 repo file(s) in context · 234490 tokens · $0.47 · 10 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:40 build: build done · commit d3086299d8b5 · 8 file(s) this round · 1 decision(s) flagged for the PR (autonomy review-at-pr) · 1792338 tokens · $1.22 · 39 turns · A borderline sector whose whole score comes from description keywords (like observability from "metrics") is now decided as not in. It no longer holds the route at review-at-pr. The related tests (130 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:49 prove: proof passed · infra-plan (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:07 judge: judge passed · round 1 · head d3086299d8b5 · record sha256 f01176a5c9324f5608f3b8735c34976230d864ccd8fbc7f60f2fd9f4c3ceedde (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 09:07 ship: draft PR opened: #193 https://github.com/arynbht/Rivetari/pull/193 · fix/t-0022 at d3086299d8b5 → main (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 08:31 1. In packages/runtime/src/router/route.ts, track which sectors gained points from anything other than a description keyword. Do this inside `add()` with a kind argument: description keyword, path, title keyword, manifest/skill trigger or IaC. Profile `join` counts as non-keyword. Add `decidedOut: Sector[]` to `Routing`: the borderline sectors (not in, score > 0) whose whole score came from description keywords. Also add `KEYWORD_ONLY_REASON = "scored only on description keywords"`. Keep `borderline` unchanged for display. Add no comments.
- 2026-11-23 08:31 2. In packages/runtime/src/router/task-route.ts `routeTask`, after the existing 'under the threshold, for the approver: …' entry, append one decision entry per decided sector when `routing.decidedOut` is non-empty, e.g. `decided not in: observability (scored only on description keywords)`. The ledger's route lines then state the decision.
- 2026-11-23 08:31 3. In packages/runtime/src/task/autonomy.ts, leave `routeConcerns`'s signature and behaviour as they are (autonomy.test.ts calls it with ['workflow'] and expects a concern). In `advanceTask`, pass only the held borderline sectors: `routed.routing.borderline` minus `routed.routing.decidedOut`.
- 2026-11-23 08:31 4. In autonomy.ts, make the resume path (`borderlineOf`) do the same: add a regex for the 'decided not in: <sector> (…)' ledger lines and drop those sectors from the parsed borderline list. A task re-advanced from its ledger then isn't held by keyword-only sectors either.
- 2026-11-23 08:31 5. Check packages/runtime/src/index.ts and export any new public names (e.g. the `decidedOut` type is already reachable through `Routing`; export `KEYWORD_ONLY_REASON` only if the tests need it). Leave packages/cli/src/commands/task.ts alone: it shows `borderline` for display, which the card allows.
- 2026-11-23 08:31 6. Add packages/runtime/src/task/keyword-borderline.test.ts. A1: call route() with real manifests (loadManifests on a temp dir) on a card whose description mentions 'metrics' and nothing else for observability. Expect observability in `borderline` and in `decidedOut`, and not in `assembly.sectors`.
- 2026-11-23 08:31 7. In the same new test file, A2: on a temp repo with RIVETARI_CONFIG_DIR set, `newTask` a card whose only borderline sectors are keyword-only. Write `.rivetari/profile.yml` with autonomy review-at-pr (or mock `repoAutonomy` the way autonomy.test.ts does), then call `advanceTask` with a context. Expect no `waiting`, 'route approved without asking' in `did`, and the ledger containing 'decided not in: observability (scored only on description keywords)'.
- 2026-11-23 08:31 8. In the same file, A3 cases: (a) a card with touches ['src/styles/**'], where ui scores only from frontend-design's path trigger, still returns `waiting` with 'borderline sector(s): ui'. (b) A context whose files include a `.tf` file, so infra scores 1 from IaC with no infra keyword; `advanceTask` holds with 'borderline sector(s): infra'. Also assert in route() that such sectors aren't in `decidedOut`.
- 2026-11-23 08:31 9. Edit packages/cli/src/commands/task.test.ts's 'at review-at-pr, stops once at the route with the reason when a sector is borderline' test, changing only its card input. Replace `draft(ann)` with an inline `runTaskNew` call: same title/type/accept, a description with no ui keyword (e.g. 'After login the app lands on a blank screen' is out because 'screen' is a ui keyword; use 'After login the app shows nothing.'), and `touches: ['src/styles/**']`, so ui scores 1 only from frontend-design's path trigger. Leave both `expect(text).toContain(...)` assertions exactly as they are, and leave the shared `draft` helper alone.
- 2026-11-23 08:31 10. Add .changeset/keyword-borderline.md: '@arynbht/rivetari-runtime': patch (and '@arynbht/rivetari': patch for the bundled behaviour), a plain sentence on keyword-only borderline sectors being decided not in, recorded in the ledger and no longer holding the route at review-at-pr.
- 2026-11-23 08:31 11. Run `pnpm build`, then `pnpm vitest related --run packages/runtime/src/router/route.ts packages/runtime/src/router/task-route.ts packages/runtime/src/task/autonomy.ts packages/runtime/src/task/keyword-borderline.test.ts packages/cli/src/commands/task.test.ts`, then `pnpm run typecheck` and `pnpm run lint`, and fix anything red.
- 2026-11-23 08:31 12. Run `pnpm action:build` and commit the rebuilt packages/action/dist/**, so CI's bundle check passes for the change under packages/runtime/src.

## Decisions

- 2026-11-23 08:29 routed to testing, docs, infra: testing (touches **/*.test.* (packages/runtime/src/task/keyword-borderline.test.ts); "test" in the description), docs (touches **/*.md (.changeset/keyword-borderline.md); skill native-writing triggers on **/*.md (.changeset/keyword-borderline.md)), infra ("iac" in the description; skill terraform-skill triggers on iac)
- 2026-11-23 08:29 under the threshold, for the approver: ui, security, perf, workflow, observability
- 2026-11-23 08:29 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:29 terraform-skill matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:29 infra: no vendored skill covers it; the agent works from the spine
- 2026-11-23 08:30 routed to testing, docs, infra: testing (touches **/*.test.* (packages/runtime/src/task/keyword-borderline.test.ts); "test" in the description), docs (touches **/*.md (.changeset/keyword-borderline.md); skill native-writing triggers on **/*.md (.changeset/keyword-borderline.md)), infra ("iac" in the description; skill terraform-skill triggers on iac)
- 2026-11-23 08:30 under the threshold, for the approver: ui, security, perf, workflow, observability
- 2026-11-23 08:30 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:30 terraform-skill matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:30 infra: no vendored skill covers it; the agent works from the spine

## Stop-and-ask

- 2026-11-23 08:40 flagged: protected_path: packages/cli/src/commands/task.test.ts — modifies a test that existed at base

## Proof

- 2026-11-23 08:49 infra-plan has no proof runner yet; the test run stands in, and a person attaches the infra-plan proof
- 2026-11-23 08:49 tests passed (pnpm run test, exit 0) · new tests: packages/runtime/src/task/keyword-borderline.test.ts: decides a sector that scored only on description keywords as not in; packages/runtime/src/task/keyword-borderline.test.ts: approves the route without asking, and the ledger says the sector was decided not in; packages/runtime/src/task/keyword-borderline.test.ts: doesn't hold a route resumed from its ledger on a keyword-only sector; packages/runtime/src/task/keyword-borderline.test.ts: still holds the route on a sector that scores from a skill's path trigger; packages/runtime/src/task/keyword-borderline.test.ts: still holds the route on a sector that scores from a skill's keyword trigger; packages/runtime/src/task/keyword-borderline.test.ts: still holds the route on infra when the repo has infrastructure as code
- 2026-11-23 08:49 output: …) to increase limit (node:564) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:564) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 08:49 evidence: the test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0022/test-run.txt?raw=true

## Judge

- 2026-11-23 09:06 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 09:06 protected: packages/cli/src/commands/task.test.ts — modifies a test that existed at base (allowed at build)
- 2026-11-23 09:07 review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 3702 tokens · $0.17
- 2026-11-23 09:07 acceptance A1: met — keyword-borderline.test.ts's first test asserts observability is in borderline and that decidedOut is ['observability'] for a 'metrics' description. decidedOut is only populated for sectors with no no…
- 2026-11-23 09:07 acceptance A2: met — The second and third tests assert the route is approved without asking, both freshly routed and resumed from the ledger, and that the ledger contains 'decided not in: observability (scored only on des…
- 2026-11-23 09:07 acceptance A3: met — Tests cover a skill path trigger (src/styles/**), a skill keyword trigger (typography) and IaC (infra/main.tf), and each still holds the route with the borderline reason.
- 2026-11-23 09:07 acceptance A4: met — The only change to task.test.ts is in the named test: draft(ann) is replaced by runTaskNew with a card that touches src/styles/**. The assertions below it are untouched.
- 2026-11-23 09:07 judge review posted: https://github.com/arynbht/Rivetari/pull/193#pullrequestreview-6018945434
