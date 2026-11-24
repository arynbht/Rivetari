---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

Host `rivetari metrics` in the runtime (`metrics/report.ts`) and add `closedTasks`, `taskMetrics` and `judgeUsage` (`metrics/tasks.ts`), so the desktop shell's History view reads the same task, cost, judge and findings numbers as the CLI without writing to sealed task ledgers. The command's output is unchanged.
