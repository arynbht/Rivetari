# @arynbht/rivetari-registry

## 1.0.0

### Major Changes

- 328afac: The software factory is now **Rivetari**. Everything is renamed, with no compatibility layer: the packages are `@arynbht/rivetari`, `@arynbht/rivetari-engine`, `@arynbht/rivetari-runtime`, `@arynbht/rivetari-catalog` and `@arynbht/rivetari-registry` (the `@arynbht/factory*` names are deprecated); the CLI is `rivetari` and the Claude Code skill `/rivetari`; a repo's state lives in `.rivetari/`, its workflow is `.github/workflows/rivetari.yml`, tasks are shared on the `rivetari/tasks` branch, environment variables are `RIVETARI_*`, the needs-a-person label is `rivetari:needs-human`, and the user's config and cache are `~/.config/rivetari` and `~/.cache/rivetari`. A repo set up with the factory needs `.factory/` moved to `.rivetari/`, its workflow, hooks and skill re-installed with `rivetari init --force`, and its tasks branch copied to `rivetari/tasks`. Ledgers signed before the rename are moved, not rewritten, so their entries still read as they were sealed and still verify.

### Minor Changes

- ad769fc: The floorplan skill (haydenschmitty/floorplan, pinned at v0.11.0) ships as a task-scope registry manifest, and a profile's new `floorplan` flag keeps its map of the codebase in `floorplan/`: `rivetari init` turns it on for new repos and draws one, and closing a merged task updates it. Rivetari runs only the skill's offline scripts, unattended, and the model's answers go through the build agent's transport with their usage logged; a failure is reported and never stops init or close. Profiles without the flag are off. `rivetari eject` removes the map.
- 0a66e93: Registry review rules: `scan_allow` binds to one exact line (sha256) with a named
  reviewer and is ignored once the lock pins another commit; licenses outside the
  OSI allow-list need a signed `license_review`; legal-sector skills must name the
  controls they serve; the `.rivetari/` scan rule matches repo paths only;
  `pnpm registry:scan` lists open findings. The judge protects the skill registry
  and agent harness settings, and runs installs and checks with an environment
  allowlist (`allowlistedEnv`; `--env` to pass more). Manifests: drop
  app-store-compliance and privacy-threshold-analysis; add a11y-core (required by
  accessibility-lead), three control-mapped privacy skills, and insecure-defaults
  (task scope, last skill commit).
- 0a66e93: Rivetari v2 step 2: the skill registry. `rivetari skills init|sync|status|add|update|vendor`
  over pinned, content-hashed skills fetched into a user-level cache
  (`~/.cache/rivetari/skills/<sha256>/`, verified on every load, mirror fallback),
  scanned before install (gitleaks, fail closed; injection rules including
  auto-run hooks; human-reviewed `scan_allow` per rule or per file). Always-scope
  skills install to `.agents/skills/` with `.claude/skills/` links, git-ignored;
  the lock travels. Ships 24 manifests from the Nov 9 research.
- 8b61010: Rivetari v2 step 5: the router. `rivetari task route <id>` routes a confirmed card to an
  assembly (sectors, phases, at most four task skills with conflicts and requirements
  resolved, spine skills, budget, checks, proof type, review options, stop-and-ask, gaps)
  in `.rivetari/tasks/<id>/assembly.yml`, with the reason for every decision in the ledger.
  Deterministic: built-in sector signals plus manifest triggers and profile flags.
  `rivetari task approve <id>` re-validates a possibly edited assembly and seals its hash,
  so a later edit fails verification. Routing refuses skills that weren't synced.
- 8b61010: Rivetari v2 step 6a: isolation and the sector agent. `rivetari task isolate <id>` gives an
  approved task its own worktree under `.worktrees/`, branch `<type>/<id>`, port and
  database name, with git hooks off inside it. `rivetari task build <id>` plans first
  (read-only, recorded in the ledger before any edit), then runs one writer in the
  worktree with a prompt assembled in a fixed order (AGENTS.md from the base, the card,
  the assembly's skills verified against the lock, a size-capped repo slice, the
  operating rules) on an allowlisted environment. The runtime commits, then checks the
  diff: a new dependency, a schema change, a sensitive or protected path, or a plan over
  budget pauses the task until `rivetari task answer <id> --allow|--deny`.

### Patch Changes

- ef50f7b: The packages publish to GitHub Packages (`https://npm.pkg.github.com`, restricted) and name this repo as their source, so a release's publish step reaches them and links each package to the repo.
- Updated dependencies [497f5bb]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [5b3e8cf]
- Updated dependencies [28e3957]
- Updated dependencies [9db492e]
- Updated dependencies [71b0956]
- Updated dependencies [e715d32]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [28e3957]
- Updated dependencies [53fa997]
- Updated dependencies [6e00240]
- Updated dependencies [a8c3169]
- Updated dependencies [28e3957]
- Updated dependencies [31821c8]
- Updated dependencies [ef50f7b]
- Updated dependencies [328afac]
- Updated dependencies [8b85843]
- Updated dependencies [eb93ad1]
- Updated dependencies [eef91ca]
- Updated dependencies [be49a10]
- Updated dependencies [ce71405]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [ad25e71]
- Updated dependencies [8b61010]
- Updated dependencies [cfba43b]
- Updated dependencies [5cb919e]
- Updated dependencies [0a66e93]
  - @arynbht/rivetari-engine@2.0.0
