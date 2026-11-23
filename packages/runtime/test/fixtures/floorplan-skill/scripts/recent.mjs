import { run } from "./fake.mjs";

run("recent.mjs", () => ({
  ok: true,
  nothingRecent: false,
  text: "src/index.js changed in the last commit",
}));
