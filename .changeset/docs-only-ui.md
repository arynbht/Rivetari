---
"@arynbht/rivetari-runtime": patch
---

A card whose touches are all Markdown (a `.md` file anywhere, or a path under `docs/`) is routed on its touches, not its wording: front-end words in its title or description, and skill triggers they match, no longer score the ui sector, so such a card doesn't bring in ui or a browser proof on wording alone. A card with any other touch, or with no touches, routes as before.
