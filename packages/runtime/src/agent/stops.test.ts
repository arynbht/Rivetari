// The protected-path stop on suppressions: a rebuilt bundle re-adds lines that
// carry the runtime's own suppression pattern, so generated files are skipped
// (T-0008 stopped on one with no suppression in its source); source isn't.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { findStops } from "./stops.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const assembly = { stop_and_ask: [] } as unknown as Parameters<
  typeof findStops
>[3];

/** A repo with `base` committed, then `change` committed on top. */
async function change(
  base: Record<string, string>,
  edits: Record<string, string>,
): Promise<{ dir: string; from: string; to: string }> {
  const dir = await mkdtemp(join(tmpdir(), "factory-stops-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const from = await write(base);
  const to = await write(edits);
  return { dir, from, to };
}

// Joined at runtime so this file's own added lines aren't suppressions.
const DISABLE = `// ${["eslint", "disable-next-line"].join("-")} no-console`;
const IGNORE = `// ${["@ts", "ignore"].join("-")}`;
const BUNDLE_LINE = `var a=2;${DISABLE}\n`;

describe("findStops on suppressions", () => {
  it("doesn't stop for a suppression-shaped line in the action's bundle", async () => {
    const { dir, from, to } = await change(
      { "packages/action/dist/index.js": "var a=1;\n", "src/a.ts": "a();\n" },
      { "packages/action/dist/index.js": `var a=1;\n${BUNDLE_LINE}` },
    );
    const stops = await findStops(dir, from, to, assembly);
    expect(stops.filter((s) => s.trigger === "protected_path")).toEqual([]);
  });

  it("doesn't stop for one in a file .gitattributes marks linguist-generated", async () => {
    const { dir, from, to } = await change(
      {
        ".gitattributes": "src/gen/** linguist-generated\n",
        "src/gen/api.ts": "export {};\n",
      },
      { "src/gen/api.ts": `export {};\n${IGNORE}\n` },
    );
    expect(await findStops(dir, from, to, assembly)).toEqual([]);
  });

  it("still stops for an eslint-disable added in a source file", async () => {
    const { dir, from, to } = await change(
      { "packages/action/dist/index.js": "var a=1;\n", "src/a.ts": "a();\n" },
      {
        "packages/action/dist/index.js": `var a=1;\n${BUNDLE_LINE}`,
        "src/a.ts": `${DISABLE}\na();\n`,
      },
    );
    const stops = await findStops(dir, from, to, assembly);
    expect(stops.filter((s) => s.trigger === "protected_path")).toEqual([
      {
        trigger: "protected_path",
        detail: `src/a.ts — adds a check suppression: ${DISABLE}`,
        reason: "suppression",
      },
    ]);
  });
});
