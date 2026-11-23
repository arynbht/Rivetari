---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-registry": minor
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

The floorplan skill (haydenschmitty/floorplan, pinned at v0.11.0) ships as a task-scope registry manifest, and a profile's new `floorplan` flag keeps its map of the codebase in `floorplan/`: `rivetari init` turns it on for new repos and draws one, and closing a merged task updates it. Rivetari runs only the skill's offline scripts, unattended, and the model's answers go through the build agent's transport with their usage logged; a failure is reported and never stops init or close. Profiles without the flag are off. `rivetari eject` removes the map.
