import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  addBanned,
  BANNED_PATH,
  type BannedList,
  BannedListSchema,
  bannedCheck,
  bannedHits,
  bannedSection,
  defaultsFor,
  loadBanned,
  saveBanned,
} from "./banned.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const list = (patterns: BannedList["patterns"]): BannedList => ({
  version: 1,
  patterns,
});

const evalBan = defaultsFor(["node"]).find((p) => p.id === "no-eval")!;

describe("banned patterns", () => {
  it("seeds defaults by stack, treating typescript as node, once each", () => {
    const ids = defaultsFor(["typescript", "node", "pnpm"]).map((p) => p.id);
    expect(ids).toEqual([
      "no-eval",
      "no-new-function",
      "no-debugger",
      "no-inner-html",
    ]);
    expect(defaultsFor(["python"]).map((p) => p.id)).toContain("no-shell-true");
    expect(defaultsFor(["go"])).toEqual([]);
  });

  it("refuses an entry whose pattern isn't a regular expression", () => {
    expect(
      BannedListSchema.safeParse({
        version: 1,
        patterns: [{ id: "bad", pattern: "(", why: "w", source: "s" }],
      }).success,
    ).toBe(false);
  });

  it("adds an id once", () => {
    const first = addBanned(list([]), evalBan);
    expect(first.added).toBe(true);
    expect(addBanned(first.list, evalBan).added).toBe(false);
  });

  it("finds a banned line only in the files it covers and not where it's allowed", () => {
    const banned = list([{ ...evalBan, allow: ["src/sandbox/**"] }]);
    const added = new Map([
      ["src/run.ts", ["const v = eval(input);", "const ok = retrieval(x);"]],
      ["src/sandbox/run.ts", ["eval(code);"]],
      ["docs/notes.md", ["call eval(x) here"]],
    ]);
    expect(bannedHits(banned, added)).toEqual([
      "no-eval: src/run.ts: const v = eval(input);",
    ]);
  });

  it("makes a tier 1 check that fails on a hit and is n/a without a list", () => {
    const added = new Map([["src/a.ts", ["eval(x);"]]]);
    expect(bannedCheck(list([evalBan]), added)).toMatchObject({
      id: "diff.no-banned-patterns",
      outcome: "fail",
      message: "banned patterns: no-eval: src/a.ts: eval(x);",
    });
    expect(
      bannedCheck(list([evalBan]), new Map([["src/a.ts", ["ok();"]]])).outcome,
    ).toBe("pass");
    expect(bannedCheck(list([]), added).outcome).toBe("n/a");
  });

  it("tells the reviewer each banned pattern as part of the contract", () => {
    const section = bannedSection(list([evalBan])).join("\n");
    expect(section).toContain("## Banned patterns (the repo's own rules)");
    expect(section).toContain('report it as a "contract" finding');
    expect(section).toContain("- no-eval:");
    expect(bannedSection(list([]))).toEqual([]);
  });

  it("reads the list from the working copy or from a commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-banned-"));
    made.push(dir);
    const git = simpleGit(dir);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    await saveBanned(dir, list([evalBan]));
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
    const base = (await git.revparse(["HEAD"])).trim();
    await mkdir(join(dir, ".rivetari"), { recursive: true });
    await writeFile(
      join(dir, BANNED_PATH),
      JSON.stringify({ version: 1, patterns: [] }),
    );
    expect((await loadBanned(dir)).patterns).toEqual([]);
    expect((await loadBanned(dir, base)).patterns.map((p) => p.id)).toEqual([
      "no-eval",
    ]);
    expect((await loadBanned(join(dir, "nowhere"))).patterns).toEqual([]);
  });
});
