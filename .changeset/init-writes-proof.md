---
"@arynbht/rivetari": minor
---

`rivetari init` writes the profile's `proof:` block for a web app with a `dev` or `start` script: `start` runs that script with the repo's package manager (`npm run dev`, `pnpm run dev`, …) and `ready_timeout` is 180 seconds, since a first `next dev` compile on Windows is slow. A UI card's proof then serves the app without the profile being edited first. A `--force` re-init keeps a `proof:` block that's already there as it is, and `proof.auth` is never written.
