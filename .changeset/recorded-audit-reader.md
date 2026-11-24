---
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari": patch
---

The engine now owns what `rivetari audit` records in `.rivetari/state.json`: `writeAuditState` writes it, `recordAudit` writes it and ratchets the coverage baseline, `readRecordedAudit` reads it back, and `summarizeResults` counts the statuses. `rivetari audit` records through these instead of its own copy, so the desktop shell reads and writes the same record and shows the same numbers. The CLI's output and state.json are unchanged.
