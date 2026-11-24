---
"@arynbht/rivetari": minor
---

`rivetari eject` now takes Rivetari out of a repo, not just the floorplan map. It is a dry run by default that lists what it would remove, move, edit and keep; `--yes` (or `--apply`) does it. It refuses while any task is open, from the same records `rivetari task status` reads. It keeps AGENTS.md, CONSTRAINTS.md, DESIGN.md, the PR template, the repo's CI (every workflow but rivetari.yml) and evidence, which moves from `.rivetari/` to `docs/evidence/`. It removes `.rivetari/`, rivetari.yml, the /rivetari skill and the skills a sync installed, Rivetari's hooks in `.claude/settings.json` (other settings stay), a CLAUDE.md that only points at AGENTS.md, the floorplan map and init's `.gitignore` and `.gitattributes` lines. The kept docs lose what referred to Rivetari: AGENTS.md keeps its protected paths, stop-and-ask list and "This repo" rules.
