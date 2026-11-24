# @arynbht/rivetari-desktop

## 0.1.0

### Minor Changes

- 28e3957: Add an agentic deep-audit swarm and an interactive Floor Plan tab.

  "Run audit" now also fans out a swarm of read-only headless Claude Code agents
  (subscription auth) that map the repository into a structured model — systems,
  subsystems, features, APIs, connectors, datastores and how they connect — persist
  it to `.rivetari/floorplan.json`, and render it as an interactive Cytoscape graph in
  a new Floor Plan tab. The deterministic scorecard is unchanged; the swarm runs
  alongside it and never blocks it. The model refreshes on audit, on demand, after a
  Fix/AI change lands, and on repo switch (staleness-aware). The swarm requires the
  Claude CLI; without it the scorecard is unaffected and the tab explains why.

- 7015a32: Add a Map tab that shows the floorplan skill's map of the repo, offline.

  The tab loads `floorplan/index.html` in a webview on its own in-memory session.
  That session cancels every request that isn't a file inside the repo's
  `floorplan/` (no http, https or ws, and no other file), and refuses every
  permission. The tab lists what it blocked, so the map's "Notify me" can't reach
  the waitlist from the shell. The webview runs with no preload or Node, with context
  isolation and the sandbox on, and floorplan's server is never started. A repo
  without a map gets an empty state that says how to make one: turn on
  `floorplan: true` in the profile, and the map is drawn at init and on each merged
  close.

- 7ad3e5f: Answer a task's stop and open its PR from the Tasks tab.

  Picking a task that waits on a stop (the build's or the judge's) shows an answer
  form: allow or deny, with a note. The main process records it through the same
  runtime calls as `rivetari task answer` (pull the tasks branch, take the lease,
  append the answer under git's user.email, push), and the tab updates from the
  watcher. A shipped task's PR link opens the https URL its ledger records in the
  browser. Both actions refuse a second click while the first runs and show their
  result or error in place.

- 59f1d0c: Replace the Build tab with a read-only Tasks tab. It shows every Rivetari task in the repo from the runtime's `watchTasks`: a "Needs you" list of tasks waiting on a person and why (a stop-and-ask, a judge escalation, a card to confirm, a route to approve, a record that fails verification), a table with each task's beat, lease holder, build and judge rounds and cost, and, for the selected task, its next step, PR link and ledger, which updates as the runtime writes it. Nothing in the tab acts on a task. The Build tab's request-to-write-agent flow, superseded by tasks, is gone along with its IPC.
- 28e3957: Close the deep-audit loop and harden the swarm.

  - **Incremental refresh**: each slice carries a content fingerprint; a refresh
    reuses unchanged slices verbatim and re-maps only what changed, skipping the
    reduce entirely when nothing moved — repeated refreshes are now cheap.
  - **Verification pass**: a bounded reviewer agent prunes implausible cross-system
    edges so the inferred connections aren't trusted single-pass.
  - **AI grounding**: the context packer injects a compact architecture summary from
    `.rivetari/floorplan.json`, so ADR / C4 / threat-model / explain-gaps are grounded
    in the repo's real systems and connections.
  - **Profile enrichment**: the Profile tab surfaces the swarm's detected
    type/stack/flags/phase as an "Apply suggestions" banner that fills the form for
    review (never auto-written — Claude drafts, humans sign).

- 28e3957: Add the orchestration layer — a feature/fix request becomes a gated PR.

  A new **Build** tab turns a natural-language request into working code: a read-only,
  floor-plan-grounded planner drafts a plan you approve, then a write-capable Claude
  agent implements it in an **isolated git worktree** (your working tree is never
  touched), self-checks against the repo's tests/lint/typecheck **and** Rivetari
  phase gate with a bounded fix-loop, and — only when the checks pass — commits,
  pushes, and opens a reviewable PR. Two human checkpoints (approve the plan, review
  the PR) keep it honest. The engine orchestrator (`orchestrate/`) is fully
  injectable and unit-tested with no `claude`/git/network.

- eef91ca: A running task now shows that it's alive. While `rivetari task run` runs a beat it writes a small progress file beside the task's directory, `.rivetari/tasks/<id>.progress.json`: the beat, when it started, when it last did something, and for the build the agent's turns, tokens and last tool so far. It's written atomically, at most every 2 seconds, and removed when the beat ends; it's never part of the ledger, the tasks branch or anything the judge hashes, and a file left by a process that died is ignored. The build agent reads `claude -p` as `--output-format stream-json --verbose` so it can count turns while the call runs, and still returns the same reply, cost, turns and turn limit from the final result. `spawnWithLimit` takes an `onLine` callback that hears stdout line by line. `watchTasks` puts each running task's progress on its view (`progress`), polls it on its own so it stays live during a slow read, counts a ledger entry as activity, and with `localFirst` lists this machine's copies at once before merging the tasks branch's view in; the branch read now loads up to 8 tasks at a time. `loadTask` takes `readOnly`.

  In the desktop Tasks tab each running task shows "Running: build · 12 min · turn 18 · last activity 20 s ago", updated every second, and "No activity for N min" in amber after five quiet minutes; "Next: …" shows only when nothing is running. The list appears from the local copies first (about 50 ms for this repo's 31 tasks, down from about 11 s) and no longer carries every task's ledger: the open task's ledger is fetched on its own (`tasks:ledger`) and again when it grows.

### Patch Changes

- 28e3957: Generate a Markdown architecture doc from the floor-plan model.

  Each deep-audit run now also writes `.rivetari/architecture.md` — a Mermaid systems
  diagram plus a per-system breakdown and the detected profile — so the architecture
  shows up in the desktop Docs tab and is a shareable, diff-able companion to the
  interactive Floor Plan.

- fa0b3eb: Sign in to GitHub with the App that `rivetari app register` recorded.

  The desktop shell's sign-in read its client id only from `RIVETARI_GITHUB_CLIENT_ID`,
  so it failed on a machine whose App was registered with the CLI. It now falls back
  to the client id in Rivetari's config directory (`app.json`), and the env var still
  wins. When neither has one, the message names both.

- Updated dependencies [08a3a60]
- Updated dependencies [497f5bb]
- Updated dependencies [d8d68e1]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [5b3e8cf]
- Updated dependencies [6b51f7a]
- Updated dependencies [28e3957]
- Updated dependencies [d4d1a10]
- Updated dependencies [9db492e]
- Updated dependencies [71b0956]
- Updated dependencies [e715d32]
- Updated dependencies [28e3957]
- Updated dependencies [0901298]
- Updated dependencies [2a4debb]
- Updated dependencies [908c1f5]
- Updated dependencies [03bb3e5]
- Updated dependencies [d958e57]
- Updated dependencies [4b5c8b2]
- Updated dependencies [9ac4aca]
- Updated dependencies [28e3957]
- Updated dependencies [ad769fc]
- Updated dependencies [53fa997]
- Updated dependencies [3578bfb]
- Updated dependencies [2b40194]
- Updated dependencies [6e00240]
- Updated dependencies [a4a1d70]
- Updated dependencies [40e611d]
- Updated dependencies [3bcd0a9]
- Updated dependencies [24781e4]
- Updated dependencies [42de90a]
- Updated dependencies [a8c3169]
- Updated dependencies [28e3957]
- Updated dependencies [a3ca4d7]
- Updated dependencies [7988d09]
- Updated dependencies [87d646b]
- Updated dependencies [31821c8]
- Updated dependencies [ef50f7b]
- Updated dependencies [328afac]
- Updated dependencies [1116fe3]
- Updated dependencies [9e16e95]
- Updated dependencies [6e4eb52]
- Updated dependencies [328afac]
- Updated dependencies [a263712]
- Updated dependencies [7ee93c7]
- Updated dependencies [8b85843]
- Updated dependencies [df42f33]
- Updated dependencies [eb93ad1]
- Updated dependencies [da6ad10]
- Updated dependencies [eef91ca]
- Updated dependencies [448f7a9]
- Updated dependencies [c9312b5]
- Updated dependencies [10ccc06]
- Updated dependencies [e31c711]
- Updated dependencies [be49a10]
- Updated dependencies [ce71405]
- Updated dependencies [9d2955f]
- Updated dependencies [0316288]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [8f0461f]
- Updated dependencies [ad25e71]
- Updated dependencies [8b61010]
- Updated dependencies [8b61010]
- Updated dependencies [cfba43b]
- Updated dependencies [5cb919e]
- Updated dependencies [4d5e653]
- Updated dependencies [0a66e93]
- Updated dependencies [29f786d]
- Updated dependencies [a13f3a1]
  - @arynbht/rivetari-runtime@1.0.0
  - @arynbht/rivetari-engine@2.0.0
  - @arynbht/rivetari-catalog@2.0.0

## 0.0.1

### Patch Changes

- Updated dependencies [fe0f33c]
- Updated dependencies [95417a3]
- Updated dependencies [5431e4b]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [b947439]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [1b932c6]
- Updated dependencies [636822f]
- Updated dependencies [2f52773]
- Updated dependencies [01d4b28]
- Updated dependencies [bc577e0]
- Updated dependencies [25b2f62]
- Updated dependencies [a60f31f]
- Updated dependencies [a156198]
- Updated dependencies [681f6ef]
- Updated dependencies [56991cf]
- Updated dependencies [3257bac]
- Updated dependencies [ba927e1]
- Updated dependencies [7c9e9eb]
- Updated dependencies [0e83bcc]
- Updated dependencies [16b72ba]
- Updated dependencies [ab8dd05]
- Updated dependencies [be6c303]
- Updated dependencies [8581cc7]
- Updated dependencies [2a4bd4d]
- Updated dependencies [96e4fa2]
- Updated dependencies [d8cf3e7]
- Updated dependencies [3b7ca5e]
- Updated dependencies [473e9bc]
- Updated dependencies [d1fb3be]
- Updated dependencies [c59168f]
- Updated dependencies [a48d87e]
- Updated dependencies [abba775]
- Updated dependencies [876bc45]
- Updated dependencies [7e613e2]
- Updated dependencies [a97d22f]
- Updated dependencies [e84788b]
- Updated dependencies [81ce412]
- Updated dependencies [fe0f33c]
- Updated dependencies [c23be6b]
- Updated dependencies [1f823bd]
- Updated dependencies [edb2260]
- Updated dependencies [1f1030b]
- Updated dependencies [869e453]
- Updated dependencies [563aea4]
- Updated dependencies [96bd726]
  - @arynbht/rivetari-catalog@1.0.0
  - @arynbht/rivetari-engine@1.0.0
