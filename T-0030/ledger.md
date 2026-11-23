# T-0030 · Don't route a docs-only card to ui on design words

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 22:47 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 22:48 intake: intake confirmed; card sha256 365c0a7bde95f8a7704d6dc3c711bbc26a6c16c0fbf36edc896bc0e7b50a9173 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 22:48 route: assembly proposed; sha256 e1d38a87868e7b3309290d55eb5ab1b363daec2fc6898790d9502695b3caeae2; skills none; proof ui-screenshots; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 22:48 route: route approved; assembly sha256 e1d38a87868e7b3309290d55eb5ab1b363daec2fc6898790d9502695b3caeae2 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 22:48 isolate: worktree .worktrees/T-0030 · branch fix/t-0030 from origin/main (6e0024095b4e) · port 5175 · db rivetari_t0030 · env sha256 93e2164e673af5992956a2dc531a39d72ecb0384a695e8f21a033752c586da39 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:48 build: build started · fast path (low risk, 2 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 15k ctx (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 23:08 build: build done · commit 4e034284cdb3 · 3 file(s) this round · 1147469 tokens · $0.82 · 27 turns · I fixed T-0030: a card whose only touches are documentation is no longer routed to ui just because its title or description says design, css, component or layout. The related router tests pass (28 fil (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 22:48 1. A1: route() for a card whose only touch is DESIGN.md and whose title and description say design, css and component doesn't put ui or a11y in, and its proof isn't ui-screenshots
- 2026-11-23 22:48 2. A2: a card touching docs/guide.md and src/app/page.tsx with the same words still routes to ui as now
- 2026-11-23 22:48 3. A3: a card with no touches and the same words routes as now

## Decisions

- 2026-11-23 22:47 risk low: no high or medium signal in the touches
- 2026-11-23 22:48 routed to ui, docs, testing: ui ("ui" in the title; "component" in the description; "layout" in the description; "design" in the title; "css" in the description), docs (touches **/*.md (.changeset/docs-only-ui.md); "docs" in the title; "documentation" in the description; skill native-writing triggers on **/*.md (.changeset/docs-only-ui.md)), testing (touches **/*.test.* (packages/runtime/src/router/docs-only-ui.test.ts))
- 2026-11-23 22:48 under the threshold, for the approver: a11y
- 2026-11-23 22:48 decided not in: a11y (scored only on description keywords)
- 2026-11-23 22:48 frontend-design matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 22:48 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 22:48 impeccable matched but isn't available (not locked, not synced, or blocked at sync)
