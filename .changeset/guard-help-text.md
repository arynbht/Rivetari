---
"@arynbht/rivetari": patch
---

`rivetari hook guard --help` and `rivetari hook --help` now name everything the guard refuses: edits to `.rivetari/**` and to the primary checkout on the default branch, shell commands that write them, and in a Rivetari repo a force push or remote delete, `git reset --hard`, `git clean -f` and `git branch -D`, so someone whose git command was refused can tell it came from the guard. The guard's behaviour is unchanged.
