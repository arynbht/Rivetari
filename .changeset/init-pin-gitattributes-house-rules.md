---
"@arynbht/rivetari": minor
---

`rivetari init` pins the Rivetari action in `rivetari.yml` to a commit SHA with the release tag as a comment (`arynbht/rivetari/packages/action@<sha> # v1.0.0`), never `@v1`. The SHA is the commit of the release the CLI belongs to (tag `v<version>`, else the latest release), read from the GitHub API; `--action-ref <sha>[:<tag>]` sets it by hand. Offline, init still finishes, but `rivetari.yml`'s step fails with a message saying the action isn't pinned and how to pin it, and a later init with a pin replaces that placeholder instead of writing a sibling. `actions/checkout` in the workflow is pinned too. Init also adds `.rivetari/** text eol=lf` to `.gitattributes` (appended once, never duplicated), and moves the rules in a repo's own CLAUDE.md into AGENTS.md's "This repo" section, leaving CLAUDE.md pointing at AGENTS.md (the old one kept as `CLAUDE.md.bak`) and saying so in its output. A CLAUDE.md that is a symlink is left alone.
