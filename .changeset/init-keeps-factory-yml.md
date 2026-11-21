---
"@arynbht/factory": patch
---

`factory init`, with or without `--force`, keeps a `.github/workflows/factory.yml` a person changed and writes the template beside it as `factory.factory.yml` to merge by hand. Before, `--force` (the only way past an existing profile) replaced it, so a repo lost its required check name, action ref and gate to the template.
