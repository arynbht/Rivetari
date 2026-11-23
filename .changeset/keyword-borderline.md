---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari": patch
---

The router no longer counts a word in the description twice. A skill whose keyword trigger matches a word the sector already scored on adds nothing, so "iac" in a description scores infra 1, not 2, and no longer puts infra in. A skill keyword found only in the description, such as terraform-skill's "state", is keyword evidence like the sector's own keywords. A skill trigger matched by a touched path still counts as path evidence.

A borderline sector whose whole score comes from words in the description is decided not in by the router. The route's ledger records `decided not in: <sector> (scored only on description keywords)`, and at review-at-pr such a sector no longer holds the route for a person, whether the task is routed now or resumed from its ledger. A borderline sector that also scores from a path, a title word, a skill's path trigger or the repo's infrastructure as code still holds the route. Keyword-only sectors stay in the borderline list the approver is shown. The runtime's `Routing` gains `decidedOut`.
