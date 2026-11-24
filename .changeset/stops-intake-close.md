---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-engine": patch
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

The schema stop now covers contract files, not only migrations. A profile can name its own under `contracts:` (a domain types file a mobile app mirrors, say), on top of built-in OpenAPI, Swagger, protobuf, GraphQL, Avro, Thrift, JSON Schema, Prisma, SQL and migration paths. A change that removes, renames or retypes anything in one, or adds something a reader must now supply, is always asked; one that only adds optional fields or new types can still be flagged for the PR under review-at-pr and above.

A new dependency is now always asked, on its own, whatever the autonomy level: it can no longer ride on the allow a person gives another stop. The stop names each package and the version it adds, from package.json, from a pnpm or npm lockfile that gains a direct dependency no package.json declares, and from requirements.txt, go.mod and Cargo.toml.

`rivetari task new` checks the card against the profile before an id is reserved. A criterion that asks for a code comment under `quality.no-new-comments`, or for something a banned pattern forbids, is refused (`--force` drafts it anyway and the ledger says so); one that changes a protected path or an existing test is drafted with a heads-up.

`.env.example`, `.env.sample` and `.env.template` are ordinary files: they no longer raise a task to high risk or get withheld from the reviewer. A real secret in one is still a stop at build and still kept from the reviewer, from its contents.

`rivetari task close --abandon` refuses while the task's PR is open (asked of GitHub, or taken from the ledger's ship record when GitHub can't be asked), while a beat is still running on this machine, or while someone else holds the task's lease, and lists what's still out there; `--force` abandons anyway. Close now prints what it did with the worktree and the branch: it removes the worktree first, then deletes the local branch once the PR is merged, which `gh pr merge --delete-branch` can't do while the worktree holds it.
