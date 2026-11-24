---
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

`inferProjectType(root)` moves from the CLI into the engine, unchanged, so the desktop's Project view reads a repo's type the way `rivetari init` does; init imports it from there with the same behaviour. The engine also gets `inferFlags(ctx)`, which reads the three risk flags a repo can show on disk (`uses-ai` from a runtime dependency on an AI SDK, `open-source` from a LICENSE or a published package's license, `distributes-binaries` from a packager such as electron-builder or GoReleaser), each with what shows it. The runtime exports `autonomyLedger`, so a reader can verify the autonomy ledger and list its entries without the view repair `ladder()` makes.
