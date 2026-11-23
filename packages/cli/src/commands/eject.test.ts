import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runEject } from "./eject.js";

describe("runEject", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  const repo = async () => {
    const d = await mkdtemp(join(tmpdir(), "rivetari-eject-"));
    made.push(d);
    return d;
  };

  it("removes the floorplan map", async () => {
    const dir = await repo();
    await mkdir(join(dir, "floorplan", "descriptions"), { recursive: true });
    await writeFile(join(dir, "floorplan", "architecture.json"), "{}\n");
    await writeFile(join(dir, "floorplan", "index.html"), "<html></html>\n");
    await writeFile(join(dir, "floorplan", "descriptions", "app.json"), "{}\n");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await runEject(dir)).toBe(0);
    await expect(access(join(dir, "floorplan"))).rejects.toThrow();
    expect(out.join("")).toBe("Removed floorplan/\n");
  });

  it("leaves a floorplan/ that belongs to the project", async () => {
    const dir = await repo();
    await mkdir(join(dir, "floorplan"));
    await writeFile(join(dir, "floorplan", "kitchen.svg"), "<svg/>\n");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runEject(dir)).toBe(0);
    expect(await readdir(join(dir, "floorplan"))).toEqual(["kitchen.svg"]);
  });
});
