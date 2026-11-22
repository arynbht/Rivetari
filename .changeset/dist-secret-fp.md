---
"@arynbht/factory-runtime": patch
---

A build round no longer stops to ask about a secret in a generated file. A rebuilt bundle re-adds every minified line it touches, so it matched whatever the old bundle already did, and every change that regenerated `packages/action/dist` stopped for nothing. The secret stop now skips the files the judge's review already treats as generated (`dist/`, lockfiles, source maps, and anything marked `linguist-generated` in `.gitattributes`). A secret that lands in a bundle comes from source, and source is still checked.
