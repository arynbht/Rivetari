---
"@arynbht/rivetari": minor
"@arynbht/rivetari-runtime": minor
---

On a pull request, `rivetari ci` now fails only on regressions. It evaluates the gate's controls at the PR's base as well as at its head, in a throwaway worktree (fetching the base commit when the checkout is shallow), and fails only for a control that passed or was n/a at base and fails at head. A control already failing at base is listed as pre-existing, and a control not evaluated at base is listed as new; neither fails the PR. The base is the merge commit's first parent, or the event's `pull_request.base.sha` when the head was checked out directly. When the base can't be read the check judges the whole repo as before and says so. The comparison is tier 1's, now exported from the runtime as `compareResults`.
