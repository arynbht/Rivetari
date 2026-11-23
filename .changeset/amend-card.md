---
"@arynbht/rivetari-runtime": minor
---

A confirmed card can be amended until the task is isolated. Before, any edit to `card.yml` after confirmation was reported as tampering, so a card that left out a path could only be abandoned and redrafted. Now a person edits the card and runs `rivetari task confirm` again: the ledger records `intake amended; card sha256 <new> (was <old>)` by whoever confirmed it, and verification checks the card against the latest hash. An earlier route approval no longer counts after an amendment, and an assembly proposed for the old card is set aside, so the route is proposed and approved again for the amended card. Once the task is isolated, confirm refuses an edited card with a message saying the card is fixed after isolate, and the edit is still reported as a problem.
