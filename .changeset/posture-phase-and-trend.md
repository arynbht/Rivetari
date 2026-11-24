---
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari": patch
---

`inferPhase(gates, results, declaredPhase)` gives the phase a repo's controls put it in (the lowest phase whose gate is defined and not green, never below the declared one), every phase's gate status and what blocks the inferred gate, by severity then effort. `rivetari status` now asks it instead of working it out itself, with the same output, so the desktop's Posture view can ask the same question of the audit recorded in state.json and get the same answer. A history.jsonl posture snapshot can carry `summary`, the status counts over every control, and `rivetari ci` now writes it, so a trend can tell failing controls from ones waiting on evidence; rows written before it read as before.
