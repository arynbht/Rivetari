import path from "node:path";

import { exists, run } from "./fake.mjs";

run("status.mjs", ({ map }) => ({
  ok: true,
  state: exists(path.join(map, "graph.json"))
    ? "map"
    : exists(path.join(map, "architecture.json"))
      ? "unbuilt"
      : "none",
}));
