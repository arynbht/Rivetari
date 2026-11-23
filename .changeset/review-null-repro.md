---
"@arynbht/rivetari-runtime": patch
---

The tier 2 review no longer crashes when the model sends a finding's `repro` (or its `file`, `detail` or `fix`, an acceptance `note`, or the false-positive gate's `repro` or `reason`) as `null`: a null or missing value means none. A suggestion with no repro is kept, a blocking finding still needs the gate to confirm a reproduction, and a rendered finding with no repro leaves the Repro line out instead of printing it empty. Before, `rivetari review --pr` exited 1 with a zod error and posted nothing.
