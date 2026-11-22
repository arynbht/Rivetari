import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runBannedAdd,
  runBannedAllow,
  runBannedList,
  runBannedSeed,
} from "./banned.js";

const made: string[] = [];
let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((s: unknown) => {
    err.push(String(s));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-banned-cli-"));
  made.push(dir);
  await mkdir(join(dir, ".factory"), { recursive: true });
  await writeFile(
    join(dir, ".factory", "profile.yml"),
    "version: 1\nname: demo\ntype: library\nstack: [typescript, node]\n",
  );
  return dir;
}

const read = async (dir: string) =>
  JSON.parse(await readFile(join(dir, ".factory", "banned.json"), "utf8")) as {
    patterns: { id: string; allow: string[]; covered_by?: string }[];
  };

describe("factory banned", () => {
  it("seeds the stack's defaults once, then lists them", async () => {
    const dir = await repo();
    expect(await runBannedSeed({ path: dir })).toBe(0);
    expect(out.join("")).toContain(
      "added no-eval, no-new-function, no-debugger, no-inner-html",
    );
    out = [];
    expect(await runBannedSeed({ path: dir })).toBe(0);
    expect(out.join("")).toContain("nothing to add");
    out = [];
    expect(await runBannedList({ path: dir })).toBe(0);
    expect(out.join("")).toContain("no-eval  /");
  });

  it("adds a pattern from a finding, refuses a duplicate or a bad regex, and allows one place", async () => {
    const dir = await repo();
    expect(
      await runBannedAdd("no-spec-section-refs", {
        pattern: String.raw`§\s*\d`,
        why: "say the rule itself",
        source: "finding: T-0004",
        coveredBy: "factory/no-spec-section-refs",
        path: dir,
      }),
    ).toBe(0);
    expect(
      await runBannedAdd("no-spec-section-refs", {
        pattern: "x",
        why: "w",
        path: dir,
      }),
    ).toBe(1);
    expect(
      await runBannedAdd("broken", { pattern: "(", why: "w", path: dir }),
    ).toBe(1);
    expect(err.join("\n")).toContain("not a valid regular expression");
    expect(
      await runBannedAllow("no-spec-section-refs", "docs/**", { path: dir }),
    ).toBe(0);
    expect(await runBannedAllow("missing", "x", { path: dir })).toBe(1);
    expect((await read(dir)).patterns).toEqual([
      expect.objectContaining({
        id: "no-spec-section-refs",
        allow: ["docs/**"],
        covered_by: "factory/no-spec-section-refs",
      }),
    ]);
  });
});
