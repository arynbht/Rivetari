---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari": patch
---

The lease now keeps a second run of a task off it on the same machine. One person on one machine was one holder, so a second `rivetari task run` of a task that was already running took the lease over, and both ran their build rounds. While a beat runs, the lease names the process running it, and any other process of the same holder is refused while that one is alive: `T-0028 is being run by process 1234 on this machine …`. The write that finishes the beat drops the process, a dead process frees the task, and `rivetari task release` still frees it at any time.
