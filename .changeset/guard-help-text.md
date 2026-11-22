---
"@arynbht/factory": patch
---

`factory hook guard --help` and `factory hook --help` now name everything the guard refuses: edits to `.factory/**` and to the primary checkout on the default branch, shell commands that write them, and in a factory repo a force push or remote delete, `git reset --hard`, `git clean -f` and `git branch -D`, so someone whose git command was refused can tell it came from the guard. The guard's behaviour is unchanged.
