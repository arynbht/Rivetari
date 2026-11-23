import path from "node:path";

import { run, write } from "./fake.mjs";

run("scan.mjs", ({ map }) => {
  write(path.join(map, ".cache", "scan.json"), {});
  return { ok: true, summary: "REPOS 1 · CODE src/index.js" };
});
