---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

`ladder()` takes `readOnly`: it verifies and reads the autonomy ledger without re-rendering `ledger.md`, and a stale view no longer counts as failed verification, since only the jsonl is sealed. The session hook and `rivetari metrics` use it, so opening a Claude Code session or reading metrics no longer leaves `.rivetari/autonomy/ledger.md` modified in a person's checkout.
