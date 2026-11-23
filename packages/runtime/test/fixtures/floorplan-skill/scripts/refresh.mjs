import { run } from "./fake.mjs";

run("refresh.mjs", () => ({
  ok: true,
  map: true,
  build: {
    ok: true,
    files: { unassignedPercent: 0 },
    descriptions: { complete: true },
  },
  next: [{ code: "recent_work", text: "Mark recent work." }],
  report: "1 file edited",
}));
