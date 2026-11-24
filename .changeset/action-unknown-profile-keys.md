---
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari": patch
---

`rivetari ci` (the GitHub Action) warns about profile keys it doesn't know and ignores them, instead of failing every PR. A profile written by a newer CLI than the pinned action no longer turns `audit-pr` red. Anything else wrong with the profile still fails. `loadProfile` and `buildContext` take the new `unknownKeys` / `profileUnknownKeys` option; the CLI's other commands stay strict, so a typo is still caught.
