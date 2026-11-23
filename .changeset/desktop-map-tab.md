---
"@arynbht/rivetari-desktop": minor
---

Add a Map tab that shows the floorplan skill's map of the repo, offline.

The tab loads `floorplan/index.html` in a webview on its own in-memory session.
That session cancels every request that isn't a file inside the repo's
`floorplan/` (no http, https or ws, and no other file), and refuses every
permission. The tab lists what it blocked, so the map's "Notify me" can't reach
the waitlist from the shell. The webview runs with no preload or Node, with context
isolation and the sandbox on, and floorplan's server is never started. A repo
without a map gets an empty state that says how to make one: turn on
`floorplan: true` in the profile, and the map is drawn at init and on each merged
close.
