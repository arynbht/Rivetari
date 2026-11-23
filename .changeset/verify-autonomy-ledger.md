---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari": patch
---

The trust ladder now re-renders a stale autonomy ledger view and verifies the ledger before reading it. A ledger that fails verification, isn't valid JSON lines, or whose key can't be read leaves the repo running supervised, gets nothing appended, and is named with its problems in `rivetari metrics` and the session-start text.
