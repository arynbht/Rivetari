---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari": patch
---

A build round that ends on the agent's question now commits what the agent wrote before it pauses, and still checks that diff for stops, so a question pause that adds a dependency or touches a protected path asks about those too. A round now commits whatever the worktree holds that HEAD doesn't, not only what changed during the round, so work an earlier round left uncommitted goes in on the next round instead of stopping on `no_change`; a task stuck that way recovers on its next `rivetari task build`. The agent's question is recorded whole instead of cut at 500 characters, and `rivetari task status` lists each open stop in full under the task waiting on it.
