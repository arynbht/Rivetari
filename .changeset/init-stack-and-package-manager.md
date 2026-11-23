---
"@arynbht/rivetari": minor
"@arynbht/rivetari-engine": minor
---

`rivetari init` fills the profile's `stack` from the repo: the stacks its manifests show, plus any `--stack` values mapped onto the stacks they imply (`nextjs` is node, `ts` is node and typescript), deduped, with names that map onto none (`postgres`) kept as given. `banned.json` is seeded from that stack, so a repo initialised without `--stack` no longer gets `stack: []` and an empty banned list. The package manager is read one way everywhere: package.json's `packageManager` field first, then a lockfile, a `pnpm-workspace.yaml` or `.yarnrc.yml`, then the one the scripts call by name. Init and the fix templates default to npm when nothing names one; verify and proof keep pnpm for that case for now.
