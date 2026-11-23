---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-runtime": minor
---

Add `proof.auth` to the profile, so UI proof can shoot pages behind sign-in instead of the login redirect. `proof.auth.script` names a JavaScript module whose default export, `async ({ page, context, baseURL }) => {}`, signs in. The proof runner runs it on each side once the app answers and before any screenshot, with rivetari's own Playwright in a child process that gets the allowlisted environment plus PORT and URL, then saves the browser's cookies and local storage as a Playwright storageState in a temp dir and shoots every page, before and after, with it. A script that throws, times out or leaves no cookies or local storage fails the proof saying why: on the base it stops the proof as a setup problem, on the change it's a failed proof sent back to build.
