# Rivetari

Rivetari sets a GitHub repository up so coding agents work in it under a written
contract, and checks the repo against a catalog of engineering controls.

- **Tasks.** `rivetari init` writes the contract (`AGENTS.md`, `CLAUDE.md`,
  `CONSTRAINTS.md`), a profile in `.rivetari/`, the `/rivetari` skill and guard hooks
  for Claude Code, and a CI workflow. Each change then runs through fixed beats: a
  task card you confirm, a route you approve, a build in its own worktree, proof from
  tools, a judge on a clean clone, and a draft PR that a person merges. The beats and
  rules are in [`AGENTS.md`](./AGENTS.md); this repo is built under them.
- **Audits.** Controls are YAML data, grouped by phase and discipline. `rivetari audit`
  reports which apply and which are met, and `rivetari fix` generates the fixes as
  pull requests. See [`docs/catalog/`](./docs/catalog/) for the rendered controls.

One TypeScript engine does the work; the CLI, the GitHub Action, the Claude Code
skill and the Electron desktop shell are clients over it. Shared state lives in
`.rivetari/` in the target repo.

## 5-minute start

You need Node 22 or later, git, [Claude Code](https://claude.com/claude-code) (the
`claude` command; the agent and the judge run on it) and a way to reach GitHub:
`gh auth login` or a `GITHUB_TOKEN`.

**1. A token for GitHub Packages.** The CLI is published to GitHub Packages, which
needs a login even to install. Create a personal access token (classic) with the
`read:packages` scope: GitHub → Settings → Developer settings → Personal access
tokens → Tokens (classic). GitHub Packages doesn't accept fine-grained tokens for
npm. Put it in your environment as `NPM_TOKEN`.

**2. Point npm at it.** Add these lines to `~/.npmrc`:

```ini
@arynbht:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

**3. Install the CLI.**

```sh
npm i -g @arynbht/rivetari
rivetari --help
```

**4. Set up a repo.** In a git repo with a GitHub `origin`:

```sh
rivetari init --yes --type web-app   # or `rivetari init` to answer the prompts
rivetari skills sync
rivetari doctor
```

`--type` is one of `web-app`, `api`, `cli`, `library`, `mobile`, `desktop`,
`data-pipeline` or `monorepo`; `rivetari init --help` lists the other flags. `init`
writes `.rivetari/`, `AGENTS.md`, `CLAUDE.md`, `CONSTRAINTS.md`, the skill and hooks
under `.claude/`, and `.github/workflows/rivetari.yml` with the Rivetari action pinned
to the commit of this CLI's release tag (`v<version>`). On a first init it also draws
a map of the codebase into `floorplan/` (git-ignored) with Claude, which takes a few
minutes and a paid model call. It finishes with a first audit.

`skills sync` installs the pinned skills the lock lists. `doctor` checks the repo,
the profile, the hooks, `claude`, GitHub access and the skills, and says what to
run for anything that fails.

Commit what `init` wrote to the default branch before the first task: the agent and
the judge read the contract from there.

**5. Run a first task.** Open Claude Code in the repo and type:

```text
/rivetari add a health check endpoint
```

or `/rivetari #42` for an issue. Rivetari writes a task card for you to confirm,
proposes the route for you to approve, builds in `.worktrees/<id>` on its own branch,
and opens a draft PR. You merge it; agents never do.

## Other clients

### GitHub Action

`rivetari init` writes `.github/workflows/rivetari.yml`, which runs the action on
pull requests and fails the job when the phase gate is red. To add it by hand:

```yaml
# .github/workflows/rivetari.yml
name: Rivetari
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: arynbht/rivetari@<commit-sha> # pin a SHA; see below
```

> **Pin a commit SHA.** The floating `v1` tag is frozen at the original 1.0.0
> release and moves only when the owner moves it. Reference the commit of a `v*`
> release tag instead, as `init` does.

### Other CLI commands

```sh
rivetari audit           # scorecard by lane; phase gate verdict
rivetari fix --pr        # open remediation PRs for the gaps it can fix
rivetari status          # the inferred phase and what blocks the next one
rivetari ai threat-model # draft an artifact for review
```

`rivetari --help` lists the rest.

## Desktop app

The desktop shell wraps the engine in a GUI: sign in, add your repos, run audits,
browse the lane scorecard and phase gates, apply fixes, and read the docs.

### Install

Installers are attached to `desktop-v*` releases on the repo's
[Releases](https://github.com/arynbht/rivetari/releases) page. None has been
published yet; until one is, run it from a clone:

```sh
pnpm install
pnpm build
pnpm --filter @arynbht/rivetari-desktop dev
```

Once a release exists:

- **macOS**: `.dmg` (Apple silicon or Intel). The build is unsigned for now, so on
  first launch right-click the app → **Open** and confirm, rather than double-clicking.
- **Windows**: `.exe` installer. SmartScreen may warn on an unsigned build; choose
  **More info → Run anyway**.
- **Linux**: `.AppImage` (mark it executable: `chmod +x *.AppImage`) or the `.deb`.

Each release also ships a CycloneDX SBOM and build-provenance attestations for the
installers.

### First run

1. Click **Sign in with GitHub** and complete the device-flow prompt in your browser
   (enter the shown code at <https://github.com/login/device>). Sign-in uses the
   GitHub App that `rivetari app register` recorded, or `RIVETARI_GITHUB_CLIENT_ID`.
   The token is stored encrypted in your OS keychain via Electron `safeStorage`; it
   never leaves your machine and never touches the renderer.
2. **Add a repo** with the folder picker, then open it to run an audit and see the
   scorecard. Shared state is written to `.rivetari/` in the target repo; the app
   keeps only personal preferences (theme, default org, update preference).

### Updates

The app doesn't update itself (ADR-0010): **Settings → Check for updates** queries
the Releases API with your signed-in token and links you to the newer installer to
download.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup and commands, and
[`AGENTS.md`](./AGENTS.md) for how changes reach `main` here. To check a published
CLI end to end from an empty folder, run `scripts/smoke-install.mjs` (its header
says how).

## License

[MIT](./LICENSE)
