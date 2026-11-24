---
"@arynbht/rivetari-runtime": minor
---

A task's view from `watchTasks` and `readTasks` now carries its card (`card`) and, once the card has been routed, assembly.yml as written (`assemblyText`), so the desktop shell can show a person what they confirm or approve. `parseAssembly(text)` reads assembly.yml's text as an assembly, or says why it can't, checking only its shape; approval still checks it against the repo. The runtime also re-exports the registry's `readLock`, `readState` and `skillsStatus` (with the `Lock` and `SyncState` types), so the shell reads the skills' lock and sync state through the runtime.
