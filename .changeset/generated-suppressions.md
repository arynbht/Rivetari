---
"@arynbht/rivetari-runtime": patch
---

A build round no longer stops, and tier 1's `diff.no-new-suppressions` no longer fails, on a suppression-shaped line in a generated file. The runtime's own suppression pattern is bundled into `packages/action/dist/index.js`, and a rebuilt bundle re-adds every minified line it touches, so any change that regenerated the bundle looked like it added a lint or type-check suppression; T-0008 stopped on exactly that with none in its source. Both checks now skip the files the judge's review and the secret stop already treat as generated (`dist/`, lockfiles, source maps, and anything marked `linguist-generated` in `.gitattributes`). Source files are still checked.
