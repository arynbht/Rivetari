# Cost bench

`bench/run.mjs` replays one task card end to end on a fresh fixture of
`BreathBand/breathband-console`, from intake through judge, and records what each
beat cost. It never runs ship or close, never pushes anywhere, and never touches a
real checkout.

```sh
pnpm install --frozen-lockfile && pnpm run build   # the bench drives this checkout's built CLI
node bench/run.mjs --self-check                     # the bench's own checks: no fixture, no AI
node bench/run.mjs --card oneline --dry             # build the fixture and card, no AI calls
node bench/run.mjs --card t0028|t0019|oneline [--keep] [--max-usd 8] [--work <dir>]
```

A run writes `bench/results/<YYYY-MM-DD>-<rivetari sha>-<card>.json` and appends a
row to `bench/results/README.md`. The sha is the last commit outside `bench/`, so
the harness's own commits don't rename the baseline. The exit code is 0 only when
the card reached ship; anything else, including a dry run's failed check, is 1.

## The cards

`bench/cards/cards.json` lists them. Each names its file and the pilot task its base
commit comes from.

| card      | what                                                                                         | base                        |
| --------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| `t0028`   | The pilot's T-0028, verbatim: Playwright e2e setup, risk medium                              | T-0028's isolate, `4190baa` |
| `t0019`   | The pilot's T-0019, verbatim: additive contract fields, risk medium                          | T-0019's isolate, `44e6ffb` |
| `oneline` | Written for the bench: one header string in `csv.ts` plus one new test, risk low, 2 criteria | same as t0019               |

`oneline` is the card for the Track 1 target: no plan call, at most 6 build turns,
under 150k tokens. It renames the sessions CSV's "Duration (s)" header and adds a
new test that pins the header line. It adds a test instead of updating one because
no existing test asserts that header, and changing an existing test is a protected
path (a stop) in Rivetari and in breathband-console's own constraints.

The base comes from the pilot's ledger (the isolate entry's "from origin/main
(sha)") in `$BENCH_ARCHIVE`, which defaults to the pilot archive of 2026-11-24. If
the archive isn't there, the run says so and uses the base in `cards.json`.

## The fixture

All of it lives under `--work` (default `$BENCH_WORK`, else `<tmp>/bench-work`). The
bench refuses a path under `Documents/Projects` or inside this repo. Keep the path
short on Windows: the task's worktree and the judge's workspace nest inside it, and
a deep scratch folder runs into the 260-character path limit.

1. `bench-cache/breathband-console.git`: a mirror clone, made once with `gh repo clone`.
   It's the only GitHub access, and later runs reuse it.
2. `bench-<card>-<stamp>/repo`: a clone of the mirror at the card's base. Its GitHub
   remote is removed, and `origin` is a local bare repo (`origin.git`) holding only
   `main`, so Rivetari's fetches, pulls and the tasks branch work offline.
3. The pilot's Rivetari setup comes back from the archive: `profile.yml`,
   `skills.lock`, `banned.json`, `waivers.yml`, `evidence.yml`, `skills/manifests/` and
   `.rivetari/.gitignore`. Tasks, history and state stay behind. The hooks are removed
   from `.claude/settings.json`, so the guard can't block the run. This goes in one
   commit on `main`, so the card's base is that commit, one past the pilot's base.
4. `npm ci`, then `rivetari skills sync` and `rivetari doctor` (recorded, not gating).

No GitHub token reaches Rivetari: `GITHUB_TOKEN` and `GH_TOKEN` are dropped and
`GH_CONFIG_DIR` points at an empty folder. With a local origin there's no repo slug,
so evidence stays local and nothing calls the GitHub API.

## The run

`rivetari task new --from <card>`, then confirm, route and approve, each only if
it's still needed. With the pilot's profile (`autonomy: review-at-pr`), `task new`
confirms and approves the card itself, and the ledger says so. Then the bench runs
`task isolate`, `task build`, `task prove` and `task judge` one at a time, as the
next step says, until ship is next. It drives the beats itself instead of
`task run`, because `task run` goes on to ship.

### Stops

A scripted policy answers stop-and-ask questions. Each answer is recorded as a human
stop in the results.

| stop                                                                                            | answer                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------- |
| `budget_exhausted` (the plan budget ran out)                                                    | allow                           |
| `new_dependency` naming only packages the card names                                            | allow, naming them              |
| `protected_path` on package.json scripts, when the card touches package.json and names a script | allow                           |
| anything else                                                                                   | stop the run: `stopped: <stop>` |

### Limits

- `--max-usd` (default $8): past it, the bench kills the running command and records
  `stopped: cost cap`. It's checked every 5 seconds on finished calls, so a call
  already running can overshoot it.
- At most 4 build commands and 3 judge rounds, then it stops and says so.
- A beat that exits non-zero without moving the ledger stops the run.

## What it records

The ledger keeps each call's tokens as one total. So the bench puts a stand-in for
`claude` first on PATH (`bench/shim/claude-shim.cs`, compiled with the .NET Framework's
`csc.exe` on Windows, a shell script elsewhere). It runs the real claude with the
exact command line, passes stdout through untouched, and keeps a copy of each
call's output. The runtime drops unknown variables from an agent's environment, so
the shim keeps its settings on disk beside itself.

From each call's final `result` line come the input, output, cache-write and
cache-read tokens, the dollars, the turns and the models, as the claude CLI reports
them. The arguments say which call it was: plan (read-only, turn-capped), build
(accepts edits) or the judge's review (json output).

Per beat (intake, route, isolate, plan, build round N, prove, judge round N, stop
answers) there are calls, turns, tokens, dollars, wall seconds and models. The
results also hold:

- the stops and how they were answered, the verdict, and whether the worktree's
  work was committed (commits past the base, a clean tree);
- `buildRounds` (build calls), `buildCommands` (`task build` runs, including ones
  that only planned), `planCalls` and `judgeRounds`;
- the ledger, its own usage notes (`ledgerUsage`, `ledgerTotals`) to check against
  the shim, and the history row, which stays empty because close never runs;
- every command with its exit code, wall time, calls and log, the setup steps with
  their status, what needed the network, `pauses` (a beat that exited 2 to ask a
  person) and `errors` (a command that failed).

The totals and the table's "wall s" add up the beats; setup (`npm ci`, skills sync)
isn't in them. A step that couldn't run is "failed" or "not run", never a pass. A
call killed before its result line shows up as `unreadCalls` on its beat, with no
tokens.

`--rescore <result.json>` works the derived fields (beats, totals, rounds, pauses,
errors) out again from a result's raw record, with the current rules, and replaces
its row in the table.

## Cleanup

Without `--keep`, the fixture is deleted at the end. Either way, any process still
running from the fixture's folder is killed and logged in `errors`, and the shim
runs claude in a job object, so claude dies with it. The judge's workspace lives in
`~/.cache/rivetari/judge/<hash>`, outside the fixture. The bench records it as
`judgeWorkspaces` but leaves it alone, because that folder is Rivetari's state.
