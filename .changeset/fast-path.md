---
"@arynbht/rivetari-runtime": minor
---

Small cards take a fast path. A low-risk card that names at most two source files (generated files and changesets don't count) gets no separate plan call: its plan is its acceptance criteria, recorded in the ledger as before. Its review runs on a smaller model (`claude-sonnet-5-5`) with a 3-minute timeout and no retries; a review that doesn't finish in time is logged and handed to the full review, so a card is never failed for it. Every other card is planned and reviewed as before.
