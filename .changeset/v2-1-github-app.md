---
"@arynbht/rivetari": minor
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-runtime": patch
---

Rivetari's GitHub App (ADR-0007, spec v2.1 §14).

- `rivetari app register [--org <org>]` creates the App from its manifest in one
  click: a local page posts the manifest to GitHub, GitHub sends you back with a
  one-time code, and the App's ID, private key and secrets are kept in the
  Rivetari's config directory (secrets readable by you only). It asks for exactly
  ADR-0007's permissions, with no webhook.
- `rivetari app status` shows whether Rivetari acts as the App in a repo;
  `rivetari app token` prints an installation token for scripts and CI.
- A new `githubToken(repo)` picks how Rivetari reaches GitHub: an explicit
  token, then `GITHUB_TOKEN`/`GH_TOKEN`, then the App when it's installed on the
  repo, then `gh auth`. `rivetari review --pr`, evidence uploads, `task ship` and
  `task close` use it, so with the App their reviews, evidence and PRs come from
  Rivetari. This also fixes `task ship` and `task close` outside tests: they
  built their GitHub client with no token, so they always failed.
- `rivetari doctor` says whether Rivetari reaches GitHub as its App or as you.
