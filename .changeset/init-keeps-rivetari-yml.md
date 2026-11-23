---
"@arynbht/rivetari": patch
---

`rivetari init`, with or without `--force`, no longer replaces a `.github/workflows/rivetari.yml` that differs from the template. It leaves the file as it is and writes the template beside it as `Rivetari.rivetari.yml`, to merge by hand and then delete: every file in `.github/workflows` runs on GitHub, so the sibling shouldn't be committed.
