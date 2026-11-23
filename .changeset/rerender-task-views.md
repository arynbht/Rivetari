---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari": patch
---

A task ledger whose `ledger.md` differs from a fresh render while every entry's seal still holds is rendered again from `ledger.jsonl` instead of reading as tampered, the same rule the autonomy ledger already follows. `ledger.md` is a view, not part of the signed record: after the rename to Rivetari every old task's view rendered differently and every task read as TAMPERED. `rivetari task resume` says when it re-rendered a view. A changed or broken entry still fails verification.
