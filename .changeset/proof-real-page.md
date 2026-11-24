---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

The UI proof now shoots the real page, not its loading state. Each shot waits for the page to render: the selector `proof.ready` names for it (one Playwright selector for every page, or a map keyed by path, glob or `*`), or, with none named, network idle, then no visible loading marker (aria-busy, a skeleton, spinner or loading class, an indeterminate progressbar, "Loading…" text), then a DOM that stays unchanged for half a second. A page on the change that doesn't render within `proof.render_timeout` seconds (default 30) fails the proof with the reason; it is still shot so a person can see it, but never passed, and axe doesn't grade it. A base page that doesn't render is noted, not blamed on the change. The proof reports each image's size in bytes, before and after, and flags a before/after pair that is byte-identical when the change touches files that render.

`proof.widths` sets the widths to shoot (default 375, 768 and 1280; other widths are named `w<width>`), and axe now runs at every width on both sides: a serious or critical violation the base already had at the same width counts as pre-existing and is reported without failing the proof.

The base side is cached in the repo's git dir by base tree, widths, pages and how the app is served, so a later proof round doesn't check out, install, serve and shoot the base again. A UI proof for a change that touches nothing that renders (docs, tests, repo or container tooling) skips the screenshots and the test run stands in.

An infra-plan proof now builds and checks the container when `proof.docker` says how: `docker build` of `file` in `context`, `docker run` with `port` published on the task's port, and a GET of `path` that must answer below 400 within `timeout` seconds. With no Docker, or a container change and no `proof.docker`, the proof says the check wasn't run and the timeline marks it `unverified: docker`, never passed.
