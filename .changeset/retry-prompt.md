---
"@arynbht/rivetari-runtime": patch
---

Build rounds no longer resume the agent's previous session, which cost more than it saved. Instead, a retry round gets a shorter fresh prompt: the contract and the card, the change so far as a diff from the base (generated files and lockfiles listed by name only, capped at 32,000 characters), the operating rules and plan, and what failed. The skills and the packed repo slice aren't sent again; the worktree is there for the agent to read.
