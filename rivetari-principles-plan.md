# Rivetari principles plan

Where Rivetari stands against the gates it has to clear before it runs its own
repo unattended. Each phase records the date it was met and the tasks that show it.

## 1.0 finish line

The owner's plan for Rivetari 1.0 (v3, 2026-11-23). The scope is frozen: only these
milestones; anything else goes in the Backlog below and waits for the bug phase.

### Milestones

Updated after each merge.

| Milestone                    | Box      | State                                                          | PRs                 |
| ---------------------------- | -------- | -------------------------------------------------------------- | ------------------- |
| M2 Fast CI                   | 1 h      | in progress: measuring, then one shadow-mode PR (owner merges) | —                   |
| M1 Close out A–E             | 45 min   | after M2 merges                                                | —                   |
| M5 BreathBand proven         | parallel | in progress: proof auth; cards 1 and 2 running in parallel     | console#6 (hygiene) |
| M3 Shell steers the work     | 2 h      | not started                                                    | —                   |
| M4 Clean install on any repo | 3 h      | not started                                                    | —                   |
| M6 Release 1.0               | 2 h      | not started                                                    | —                   |

Before 1.0, tracks A–E merged on 2026-11-23: #196, #197 and #199–#209 (timeouts,
derived risk, blocking-only findings, affected-only tier 1, the context cap, watchTasks
and the Tasks tab, parallel runs, bugs 9, 19 and 21, Floorplan stage 1).

### Rules

1. Only the milestones here. Anything else goes in the Backlog (id, one line,
   blocker/major/minor, where found) and waits for the bug phase.
2. A bug is fixed now only if it blocks the current milestone's done-check: one
   attempt, as its own small PR. If it fails, work around it, log it and continue.
   Never chain a fix into another fix.
3. Decide anything reversible and note it in the PR; one batched message to the owner
   per milestone. Stop at once only for a hard stop that can't be answered, for
   signing, leases or the autonomy ledger, or for a usage or CI-minutes limit.
4. Time boxes are ceilings. Past 150%: stop that milestone, report what's left, move on.
5. This repo: plain PRs from parallel subagents on disjoint packages. The gate is CI
   green and `rivetari review --pr` with no blocking findings, both on the exact commit
   being merged. Don't rebase before merging unless GitHub reports a conflict. The
   agent merges, except workflow/CI config, AGENTS.md, CONSTRAINTS.md, DESIGN.md,
   lint/architecture config, signing/leases/autonomy, and any PR with a blocking
   review: those wait for the owner. Never dismiss a blocking review without the
   owner's OK on that specific PR.
6. BreathBand repos: only `rivetari` tasks at review-at-pr. For `.github/workflows/**`
   or `.rivetari/**` there, the owner gets the exact diff to apply.
7. No polishing: when the done-check passes, move on.
8. One short message per milestone: done-check, PRs, time against the box, backlog rows
   added, questions. Costs include subagent tokens.

### M2: Fast CI (first; 1 h)

Measure the last 20 runs first (wall time and minutes per job, per OS, PR vs push; time
in install, build, lint, typecheck, tests and e2e). Then one revertible plain PR, which
the owner merges:

- The only required check on PRs is a fast `ci` aggregator over Ubuntu jobs; lint,
  typecheck and test run as parallel jobs; if lint or typecheck fails, the aggregator
  fails without waiting for tests. Windows, e2e and full-history scans aren't required
  on PRs.
- Lint, typecheck and test only for affected packages and their dependents (the same
  logic as the judge's #202), fetching only the base commit needed. A full run when the
  diff touches root package.json, pnpm-lock.yaml, pnpm-workspace.yaml, base tsconfig,
  eslint/vitest/prettier config, .github/** or build scripts. Tests are sharded across
  2–3 jobs if they're still the long pole.
- Path filters at job level only (SHA-pinned); the aggregator always runs, so a skipped
  job never leaves a PR waiting. Docs, \*.md and .changeset/\*\* skip build and test;
  desktop-e2e runs only on apps/desktop/\*\* and packages/runtime/\*\*; catalog,
  docs-site and skill-manifest validation only when those paths change.
- Caching: the pnpm store, TypeScript build info and the vitest cache (lockfile + sha);
  build only what affected tests need.
- `concurrency` on every workflow, cancelling only on pull_request, never on main;
  `timeout-minutes` on every job. Push only on main, pull_request for PRs; drafts skip
  CI until ready_for_review.
- Main: a full run on every push and nightly on both OSes; a red main opens or updates
  a "main is red" issue, and agents stop merging until it's green. Windows build-test
  only on main and nightly.
- gitleaks on the PR's commits on PRs, full history weekly. The rivetari audit on
  pull_request and weekly, not on push. `ci-full.yml` keeps the old pipeline on
  workflow_dispatch or the `ci:full` label.
- Lint, typecheck and test report success without running when a green
  `rivetari/judge` check exists on the same sha (posted from M4).
- Shadow mode: the new workflow runs beside the old one, non-required, on 3 PRs; the
  required check switches only when they agree. The owner runs the ruleset call.
  Self-hosted runners: Backlog only.

Done when, on real PRs: a typical code PR's required check finishes in 5 min or less, a
docs-only PR in 1 min or less, and merging a PR that needs no rebase re-runs no open
PR's checks.

### M1: Close out A–E (45 min, after M2 merges)

Main's full CI green on the combined head (fix only what broke); the seven dismissed
blocking reviews listed for the owner to confirm or reopen; one low-risk regression
card through `/rivetari` on this repo, then two cards with `--parallel 2`. Done when
main is green, the regression card goes card-to-PR in 10 min or less, for $1 or less
and with no prompts, and the parallel pair doesn't collide.

### M5: BreathBand proven (parallel lane)

Resume T-0002 (DESIGN.md) after the owner adds `proof.start` and commits ledger.md.
`proof.auth` (a plain Rivetari PR) signs in the demo coach and saves a Playwright
storageState for the screenshot runner, with one signed-in screenshot of
/cloud/trends/ before card 3. Cards, all confirmed: (1) Overview ignores the coach's
targets; (2) the Compare CSV export, in parallel with 1; (3) the Measure-button overflow,
after proof auth works, at 375/768/1280. Done when all four are merged through Rivetari,
with at most one prompt per card and a card-to-PR median of 15 min or less.

### M3: Shell steers the work (2 h)

"Needs you" gets actions (allow or deny a stop with a note, open the PR) through the
runtime API only; the Map tab shows Floorplan's static export in a webview with network
requests blocked; exact launch steps for the owner. Done when the owner can watch a
card, answer its stop and open its PR without a terminal, and see the console map.

### M4: Clean install on any repo (3 h, subagents)

init: F1 (stack from the detector, banned list seeded from it), F3 (package manager
inference), F2 (`.rivetari/** text eol=lf`), bug 22 (history.jsonl ignored), house rules
(the judge reads CLAUDE.md, or init moves them to "This repo"), the action SHA-pinned,
F5 (the PR check fails only on regressions), F6 (free-plan n/a), and the router not
treating "design" in a docs-only card as UI. CI for installed repos: init writes CI from
M2's workflows adapted to visibility and plan; `ci.budget` in the profile with minutes
per PR in history.jsonl and the status issue, and doctor warning at 75%; the
`rivetari/judge` check run posted on the head sha with the ledger hash
(`ci.trust_judge` true on own repos, false on client repos); CI/CD posture controls,
each with a fix. Applied to both BreathBand repos (diffs to the owner under rule 6).
Done when `rivetari init` on a fresh private Next.js scratch repo needs zero hand edits,
doctor is green, and a Rivetari PR there finishes its required check in 3 min or less
using 5 CI minutes or less.

### M6: Release 1.0 (2 h)

eject: a dry run by default, refuses while tasks are open, keeps AGENTS.md,
CONSTRAINTS.md, DESIGN.md, the PR template, CI and evidence, and is tested on node,
python, go and rust fixtures (green, no Rivetari reference left). Publish the CLI with a
smoke test from a clean path; moving v1 waits for the owner; a README with install and a
5-minute start. Done when install from the package, init, one card and a PR work on a
fresh repo, and eject leaves it green.

### Not in 1.0

Proof and Judge views; Policy, Skills and Clients tabs; Floorplan stage 3; the verify
skill and design pass; Garden; the rules-from-findings loop; skill measurement and the
interview skill; client lifecycle beyond eject; `upgrade`; ADRs; cards editing
workflows or `.rivetari/**`.

### After 1.0

Work the Backlog: blockers, then majors, then minors, oldest first within each; each fix
goes through `rivetari` as a regression check.

### Backlog

| Id  | Item                                                                                                  | Severity | Found          |
| --- | ----------------------------------------------------------------------------------------------------- | -------- | -------------- |
| B1  | The timeout's `killTree` kills only the direct child on POSIX (the whole tree on Windows)             | major    | #201 review    |
| B2  | The run budget kills claude calls only, not tier 1 checks or a hung proof server                      | major    | #201 report    |
| B3  | `task build` or `task judge` run on their own exit 1 on a timeout instead of stopping                 | minor    | #201 report    |
| B4  | close.ts records the card's intake risk in history, not a risk the judge raised                       | minor    | #207 report    |
| B5  | Workspace deps declared under an alias aren't seen as dependents by affected-only tier 1              | minor    | #202 review    |
| B6  | Two merged closes at once can race on `floorplan/`, and close maps a checkout that may lack the merge | minor    | #205 review    |
| B7  | Inside the desktop app, Floorplan's runner uses Electron's `process.execPath`, not node               | major    | #205 review    |
| B8  | The "decided not in:" ledger text is parsed in autonomy.ts without a shared constant                  | minor    | #204 review    |
| B9  | A docs card that reads a whole design system costs about $3 (84 turns), outside the slice cap         | major    | console T-0002 |
| B10 | CI didn't fire when one PR opened (#194); closing and reopening it re-triggered CI                    | minor    | 2026-11-23     |
| B11 | Renaming or migrating Rivetari state should refuse while tasks are open (bug 13)                      | major    | the rename     |
| B12 | `closeTask` silently skips a worktree whose recorded absolute path moved (bug 16)                     | minor    | the rename     |
| B13 | A self-hosted CI runner                                                                               | minor    | the M2 plan    |

## Phase A: a real task runs at review-at-pr without asking

**Gate:** a real change to this repo goes through `/rivetari` at `review-at-pr` with
no prompts (no card confirmation, route approval, stop-and-ask or judge escalation
for a person) and one build round.

**Met 2026-11-22** by T-0007.

|                             | T-0006                                         | T-0007                                                 |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Task                        | `init --force` keeps a customised rivetari.yml | the guard hook's help text names everything it refuses |
| PR                          | #170                                           | #173                                                   |
| Wall time, card to draft PR | 44 min                                         | 12 min                                                 |
| Cost (ledger)               | $1.49                                          | $1.18                                                  |
| Tokens (ledger)             | 1,498,630                                      | 775,971                                                |
| Build rounds                | 2                                              | 1                                                      |
| Prompts                     | 2                                              | 0                                                      |
| Retry rounds                | 50%                                            | 0%                                                     |

- **T-0006** asked twice. The route waited for a person because the router scored
  the workflow sector as borderline from one word in the description. The build
  stopped on an edited existing test and on a secret false positive in the
  regenerated action bundle. The judge then sent it back once, on
  `diff.no-new-comments`.
- **Between them:** #171 stopped the secret stop firing on generated files, and #172
  stopped `diff.no-new-comments` counting an edited comment as a new one.
- **T-0007** was confirmed, routed, built, proved, judged and shipped with no person
  involved until the merge.
- **Cost:** the planning call was $0.50 of T-0007's $1.18. A review's token count
  through the Claude Code CLI is under-reported, so both costs are a floor.

**What it changes:** the AGENTS.md exemption that let runtime fixes ship as plain
PRs is withdrawn. From here every change to this repo goes through `/rivetari`.
