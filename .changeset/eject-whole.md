---
"@arynbht/rivetari": minor
---

`rivetari eject` now takes Rivetari out of a repo, not just the floorplan map. It is a dry run by default that lists what it would remove, put back and move; `--yes` (or `--apply`) does it. It removes Rivetari's own paths whole: `.rivetari/`, rivetari.yml, the /rivetari skill and the skills a sync installed, the `*.rivetari.*` files init writes beside the repo's own, and the floorplan map. Evidence moves from `.rivetari/` to `docs/evidence/`.

For everything else it goes by `.rivetari/manifest.json`, which `rivetari init` now writes: each file init created or changed outside `.rivetari/`, with its hash. A file init created and nobody has changed since is deleted; a file init replaced gets init's `.bak` put back. Eject edits no file it keeps: a file changed since init, one init only appended to, or one in a repo set up before the manifest is left as it is, and eject lists the lines in it that name Rivetari for a person to take out.

It refuses while any task is open, and whenever it can't tell: when the tasks branch can't be fetched, git can't read the repo, or the task listing has to skip a record.
