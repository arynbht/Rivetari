---
"@arynbht/factory-catalog": patch
---

The `/factory` skill follows what `factory task new` already does above `supervised`: when the CLI says it confirmed the card and approved the route and prints `next: factory task run <id>`, the skill goes straight to the run instead of asking. When the CLI stops at the route with a reason, the skill shows the reason and asks once.
