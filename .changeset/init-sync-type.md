---
"@arynbht/rivetari": minor
---

`rivetari init` syncs the skills it locks, so `rivetari doctor` is green straight after it instead of saying the skills have never been synced. It uses the same sync as `rivetari skills sync`. Offline, or when the sync fails or blocks a skill, init says so and tells you to run `rivetari skills sync`; init still exits 0. With `--yes` and no `--type`, a first init reads the type from the repo's manifests and prints it: a pnpm or yarn workspace is a monorepo, a package.json with `bin` is a cli, one that depends on next, react, vue, svelte, vite or a similar framework is a web-app, one with main or exports and no framework is a library, Django is a web-app, and FastAPI or Flask is an api. `--type` still wins, a re-init never guesses, and a repo that fits none of these still needs `--type`.
