---
"@arynbht/factory-runtime": patch
---

`diff.no-new-comments` no longer counts an edited comment as a new one. Within each hunk of the change, a comment block it adds is matched to one it removes at the same indentation, and each removed line covers one added line: rewording a doc comment passes, while swapping a deleted comment for an unrelated one elsewhere still fails. Before, the check failed on any added comment line, and in T-0006 the retry deleted an existing doc comment to get past it. A judge that sends a change back now also tells the agent that a tier 1 failure is fixed by changing the code that triggered it, never by deleting something that existed at base.
