import path from "node:path";

import { exists, read, run, write } from "./fake.mjs";

run("build.mjs", ({ map }) => {
  if (!exists(path.join(map, "architecture.json")))
    return { ok: false, errors: ["no architecture.json"] };
  write(path.join(map, "graph.json"), {});
  write(path.join(map, "index.html"), "<!doctype html><title>map</title>\n");
  const desc = path.join(map, "descriptions", "app.json");
  const complete =
    exists(desc) &&
    Object.values(read(desc).files ?? {}).every((f) => f.description);
  return {
    ok: true,
    files: { unassignedPercent: 0 },
    descriptions: { complete },
    report: "built",
  };
});
