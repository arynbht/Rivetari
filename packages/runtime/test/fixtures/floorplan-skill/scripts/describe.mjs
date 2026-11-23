import path from "node:path";

import { exists, read, run, write } from "./fake.mjs";

run("describe.mjs", ({ map }) => {
  const desc = path.join(map, "descriptions", "app.json");
  if (
    exists(desc) &&
    Object.values(read(desc).files ?? {}).every((f) => f.description)
  )
    return { ok: true, nothingToDo: true, worksheets: [] };
  write(path.join(map, ".cache", "worksheets", "app.md"), "## src/index.js\n");
  if (!exists(desc))
    write(desc, { files: { "src/index.js": { name: "", description: "" } } });
  return {
    ok: true,
    nothingToDo: false,
    style: "plain words",
    worksheets: [
      {
        key: "app",
        worksheet: "floorplan/.cache/worksheets/app.md",
        descriptions: "floorplan/descriptions/app.json",
      },
    ],
  };
});
