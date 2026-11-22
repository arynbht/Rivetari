# Factory principles plan

Where the factory stands against the gates it has to clear before it runs its own
repo unattended. Each phase records the date it was met and the tasks that show it.

## Phase A: a real task runs at review-at-pr without asking

**Gate:** a real change to this repo goes through `/factory` at `review-at-pr` with
no prompts (no card confirmation, route approval, stop-and-ask or judge escalation
for a person) and one build round.

**Met 2026-11-22** by T-0007.

|                             | T-0006                                        | T-0007                                                 |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Task                        | `init --force` keeps a customised factory.yml | the guard hook's help text names everything it refuses |
| PR                          | #170                                          | #173                                                   |
| Wall time, card to draft PR | 44 min                                        | 12 min                                                 |
| Cost (ledger)               | $1.49                                         | $1.18                                                  |
| Tokens (ledger)             | 1,498,630                                     | 775,971                                                |
| Build rounds                | 2                                             | 1                                                      |
| Prompts                     | 2                                             | 0                                                      |
| Retry rounds                | 50%                                           | 0%                                                     |

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
PRs is withdrawn. From here every change to this repo goes through `/factory`.
