# Rivetari principles plan

Where Rivetari stands against the gates it has to clear before it runs its own
repo unattended. Each phase records the date it was met and the tasks that show it.

## Status

Updated after each merge. Rivetari's own changes ship as plain PRs under the exemption
in AGENTS.md (2026-11-23); cards run on breathband-console.

| Item                                                             | Track | PR        | State                               |
| ---------------------------------------------------------------- | ----- | --------- | ----------------------------------- |
| Rebuild the action bundle once per release                       | —     | #196      | merged 2026-11-23                   |
| Task PRs don't commit the action bundle (AGENTS.md)              | —     | #197      | merged 2026-11-23                   |
| Bug 20: per-call and per-task timeouts                           | A     | #201      | merged 2026-11-23                   |
| Risk derived at intake, recomputed at the judge                  | A     | #207      | merged 2026-11-23                   |
| Findings per PR counts blocking findings only                    | A     | #209      | merged 2026-11-23                   |
| Affected-only tier 1                                             | B     | #202      | merged 2026-11-23                   |
| Context cap redone: slice, enforced plan turns, 15k for low risk | B     | #208      | merged 2026-11-23 (replaces #189)   |
| Bug 21: a null repro doesn't crash the review                    | B     | #206      | merged 2026-11-23                   |
| `watchTasks` runtime API                                         | C     | #199      | merged 2026-11-23                   |
| Read-only Tasks tab in the shell                                 | C     | #203      | merged 2026-11-23                   |
| `task run --parallel N` with overlap checks                      | D     | #200      | merged 2026-11-23                   |
| Bug 9 + 19: keyword-only sectors don't hold the route            | D     | #204      | merged 2026-11-23 (replaces #193)   |
| Floorplan stage 1                                                | E     | #205      | merged 2026-11-23                   |
| Regression card through `/rivetari` on this repo                 | —     | —         | next                                |
| breathband-console: F2 + hygiene                                 | cards | console#6 | merged 2026-11-23                   |
| breathband-console: DESIGN.md                                    | cards | —         | built; proof waits on `proof.start` |
| breathband-console: three card proposals                         | cards | —         | drafted, for the owner to pick      |

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
