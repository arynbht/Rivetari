---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari": minor
---

Rivetari v2 step 7b: `/rivetari` as the single entry point.

- `rivetari init` writes the §10 files without overwriting: an existing file gets
  Rivetari's version beside it as `name.rivetari.ext`. The files are AGENTS.md
  (the contract, with a repo section listing the detected stack and commands),
  CLAUDE.md pointing at it, a CONSTRAINTS.md seed for the judge, the PR template
  with `## Proof`, `.claude/settings.json` hooks, and the v2 `/rivetari` skill. It
  also locks the spine skills and adds `.rivetari/.gitignore` entries.
- `rivetari task run <id>` takes an approved task through isolate, build, prove,
  judge and ship, reporting each ledger entry as it lands. It stops wherever a
  person is needed, and after four build rounds.
- `rivetari doctor` checks the profile, the `claude` CLI, GitHub access and skills.
- `rivetari hook session-start` and `rivetari hook guard`: the guard refuses edits to
  `.rivetari/**`, and edits in the primary checkout while it's on the default branch.
