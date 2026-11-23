# T-0029 · Read branch-protection controls as n/a on free-plan private repos

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 22:47 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 22:47 intake: intake confirmed; card sha256 4bca49abb9c272dae4e801fb38ce102575a0510f00f76166e828b9d73ffa9c2d (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 22:47 route: assembly proposed; sha256 89af3c7e3a384eb21690dcb66fd281c98fe37b9f58793c504d5eeab1911072bc; skills none; proof api-contract; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 22:47 route: route approved; assembly sha256 89af3c7e3a384eb21690dcb66fd281c98fe37b9f58793c504d5eeab1911072bc (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 22:48 isolate: worktree .worktrees/T-0029 · branch fix/t-0029 from origin/main (6e0024095b4e) · port 5174 · db rivetari_t0029 · env sha256 15c06bc2a550c12d53431d1104576cf9d7393d2222d4e0ce454d8cdbdd1bf3cb (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:48 build: build started · fast path (low risk, 2 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 15k ctx (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:51 build: build done · commit 23bd9207f91a · 5 file(s) this round · 1523099 tokens · $1.10 · 40 turns · Private repos on GitHub's free plan now get **n/a** on the three branch-protection checks instead of a skip or a fail. The related tests (86, including the 26 new ones), the full typecheck, and eslint (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:01 prove: proof failed · api-contract (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:02 build: build paused: 1 thing(s) to ask about · commit 23bd9207f91a · 210798 tokens · $0.29 · 6 turns · retry (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 22:48 1. A1: for a private repo whose protection endpoint answers GitHub's plan-upgrade 403, branch-protection, required-pull-request and required-status-checks report n/a with a reason naming the free plan
- 2026-11-23 22:48 2. A2: a public repo, or a private repo on a paid plan, with no protection still fails those checks as now
- 2026-11-23 22:48 3. A3: any other 403 or API error is handled exactly as now

## Decisions

- 2026-11-23 22:47 risk low: no high or medium signal in the touches
- 2026-11-23 22:47 routed to docs, api, testing: docs (touches **/*.md (.changeset/free-plan-protection-na.md); skill native-writing triggers on **/*.md (.changeset/free-plan-protection-na.md)), api ("api" in the description; "endpoint" in the description), testing (touches **/*.test.* (packages/engine/src/detectors/github-api-free-plan.test.ts))
- 2026-11-23 22:47 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 23:02 asked: agent_question: The full `pnpm test` run went past the proof runner's 600s limit, but this task's tests pass in about 10s. Can you rerun the test proof with a longer limit (or check whether base also goes past 600s), then attach the api-contract proof?

## Proof

- 2026-11-23 23:01 api-contract has no proof runner yet; the test run stands in, and a person attaches the api-contract proof
- 2026-11-23 23:01 tests couldn't run: "pnpm" did not finish within 600s
