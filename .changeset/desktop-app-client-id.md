---
"@arynbht/rivetari-desktop": patch
---

Sign in to GitHub with the App that `rivetari app register` recorded.

The desktop shell's sign-in read its client id only from `RIVETARI_GITHUB_CLIENT_ID`,
so it failed on a machine whose App was registered with the CLI. It now falls back
to the client id in Rivetari's config directory (`app.json`), and the env var still
wins. When neither has one, the message names both.
