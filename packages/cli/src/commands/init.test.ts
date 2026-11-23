import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "./init.js";
import { GUARD_COMMAND, SESSION_START_COMMAND } from "./init-files.js";

// Each init runs a full audit, and some run it more than once: slower on Windows CI.
describe("runInit (integration)", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "rivetari-init-"));
    made.push(d);
    return d;
  };

  it("seeds the banned list from the stack, and keeps one that's there", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runInit(
        dir,
        { type: "cli", stack: "typescript,node", yes: true },
        { token: null },
      ),
    ).toBe(0);
    const seeded = JSON.parse(
      await readFile(join(dir, ".rivetari", "banned.json"), "utf8"),
    ) as { patterns: { id: string }[] };
    expect(seeded.patterns.map((p) => p.id)).toEqual([
      "no-eval",
      "no-new-function",
      "no-debugger",
      "no-inner-html",
    ]);
    const mine = '{ "version": 1, "patterns": [] }\n';
    await writeFile(join(dir, ".rivetari", "banned.json"), mine);
    expect(
      await runInit(
        dir,
        { type: "cli", stack: "typescript,node", yes: true, force: true },
        { token: null },
      ),
    ).toBe(0);
    expect(await readFile(join(dir, ".rivetari", "banned.json"), "utf8")).toBe(
      mine,
    );
  });

  it("writes config + workflow and runs the first audit", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await runInit(
      dir,
      {
        type: "cli",
        name: "demo",
        phase: "scaffold",
        flag: ["open-source"],
        yes: true,
      },
      { token: null },
    );

    expect(code).toBe(0);
    const profile = await readFile(
      join(dir, ".rivetari", "profile.yml"),
      "utf8",
    );
    expect(profile).toContain("type: cli");
    expect(profile).toContain("open-source: true");
    await expect(
      access(join(dir, ".rivetari", "waivers.yml")),
    ).resolves.toBeUndefined();
    const workflow = await readFile(
      join(dir, ".github", "workflows", "rivetari.yml"),
      "utf8",
    );
    expect(workflow).toContain("name: rivetari");
    expect(workflow).toContain("cron:");
    expect(workflow).toContain("gate: scaffold");

    // §10: the /rivetari skill, the contract, its hooks and the PR template.
    const read = (...p: string[]) => readFile(join(dir, ...p), "utf8");
    const skill = await read(".claude", "skills", "rivetari", "SKILL.md");
    expect(skill).toContain("name: rivetari");
    expect(skill).toContain("rivetari task run <id>");
    const agents = await read("AGENTS.md");
    expect(agents).toContain("Run `rivetari doctor`");
    expect(agents).toContain("## Stop and ask");
    expect(agents).toContain("- `.rivetari/**`");
    expect(agents).toContain("- **demo**: cli, phase scaffold");
    expect(await read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(await read("CONSTRAINTS.md")).toContain("No new dependency");
    expect(await read(".github", "PULL_REQUEST_TEMPLATE.md")).toContain(
      "## Proof",
    );
    const settings = JSON.parse(await read(".claude", "settings.json")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(
      SESSION_START_COMMAND,
    );
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      GUARD_COMMAND,
    );
    expect(await read(".rivetari", ".gitignore")).toBe(
      "tasks/\nai-usage.log\ncache/\nhistory.jsonl\n*.bak\n*.bak.*\n",
    );
    // The spine skills are locked; task-scope skills aren't.
    const lock = await read(".rivetari", "skills.lock");
    expect(lock).toContain("scope: always");
    expect(lock).not.toContain("scope: task");
  });

  it("never overwrites a file the repo already has: Rivetari's version goes beside it", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await writeFile(join(dir, "AGENTS.md"), "# Our own rules\n");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
    );
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(
      "# Our own rules\n",
    );
    const ours = await readFile(join(dir, "AGENTS.rivetari.md"), "utf8");
    expect(ours).toMatch(
      /Commands: install `npm install` · lint `npm run lint` · test `npm run test`/,
    );
    expect(await readFile(join(dir, "CONSTRAINTS.md"), "utf8")).toContain(
      "`npm run lint`, `npm run test` pass",
    );

    // --force replaces it, and keeps the person's version as a backup, never
    // over a backup that's already there.
    await writeFile(join(dir, "AGENTS.md.bak"), "# my notes\n");
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true, force: true },
        { token: null },
      ),
    ).toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(ours);
    expect(await readFile(join(dir, "AGENTS.md.bak"), "utf8")).toBe(
      "# my notes\n",
    );
    expect(await readFile(join(dir, "AGENTS.md.bak.1"), "utf8")).toBe(
      "# Our own rules\n",
    );
    // A second --force after the generated file changes keeps every version.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc" } }),
    );
    await runInit(
      dir,
      { type: "cli", yes: true, force: true },
      { token: null },
    );
    expect(await readFile(join(dir, "AGENTS.md.bak.1"), "utf8")).toBe(
      "# Our own rules\n",
    );
    expect(await readFile(join(dir, "AGENTS.md.bak.2"), "utf8")).toBe(ours);
  });

  it("merges its hooks into an existing settings.json, keeping everything else", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const theirs = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [
          // Theirs, kept as it is.
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "./audit.sh" }],
          },
          // An earlier init's guard: replaced, not duplicated.
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [{ type: "command", command: "rivetari hook guard" }],
          },
        ],
      },
    };
    const original = `${JSON.stringify(theirs, null, 2)}\n`;
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, ".claude", "settings.json"), original);
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);

    const read = (...p: string[]) => readFile(join(dir, ...p), "utf8");
    const merged = JSON.parse(await read(".claude", "settings.json")) as {
      permissions: unknown;
      hooks: Record<
        string,
        { matcher?: string; hooks: { command: string }[] }[]
      >;
    };
    expect(merged.permissions).toEqual(theirs.permissions);
    expect(
      merged.hooks.PreToolUse?.map((g) => [g.matcher, g.hooks[0]?.command]),
    ).toEqual([
      ["Bash", "./audit.sh"],
      ["Edit|Write|MultiEdit|NotebookEdit|Bash", GUARD_COMMAND],
    ]);
    expect(merged.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(
      SESSION_START_COMMAND,
    );
    expect(await read(".claude", "settings.json.bak")).toBe(original);
    await expect(
      access(join(dir, ".claude", "settings.rivetari.json")),
    ).rejects.toThrow();

    // A re-run converges: nothing to merge, so no second backup.
    await runInit(
      dir,
      { type: "cli", yes: true, force: true },
      { token: null },
    );
    await expect(
      access(join(dir, ".claude", "settings.json.bak.1")),
    ).rejects.toThrow();
  });

  it("puts its hooks beside a settings.json it can't parse, and says the guard is off", async () => {
    const dir = await tmp();
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, ".claude", "settings.json"), "{ // comments\n}");
    await runInit(dir, { type: "cli", yes: true }, { token: null });
    expect(await readFile(join(dir, ".claude", "settings.json"), "utf8")).toBe(
      "{ // comments\n}",
    );
    await expect(
      access(join(dir, ".claude", "settings.rivetari.json")),
    ).resolves.toBeUndefined();
    expect(out.mock.calls.join("")).toMatch(/the guard is off/);
  });

  it("--force backs up what it replaces, and never resets waivers or evidence", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit(dir, { type: "cli", yes: true }, { token: null });
    const read = (...p: string[]) => readFile(join(dir, ...p), "utf8");
    const waiver =
      "- control: docs.runbooks-dir\n  reason: not yet\n  expires: 2027-01-01\n  owner: '@me'\n";
    await writeFile(join(dir, ".rivetari", "waivers.yml"), waiver);
    await writeFile(join(dir, ".rivetari", "evidence.yml"), "- note: kept\n");
    const profile = await read(".rivetari", "profile.yml");
    const workflow = await read(".github", "workflows", "rivetari.yml");

    await runInit(
      dir,
      { type: "library", phase: "build", yes: true, force: true },
      { token: null },
    );
    expect(await read(".rivetari", "waivers.yml")).toBe(waiver);
    expect(await read(".rivetari", "evidence.yml")).toBe("- note: kept\n");
    expect(await read(".rivetari", "profile.yml")).toContain("type: library");
    expect(await read(".rivetari", "profile.yml.bak")).toBe(profile);
    expect(await read(".github", "workflows", "rivetari.yml")).toBe(workflow);
    expect(
      await read(".github", "workflows", "rivetari.rivetari.yml"),
    ).toContain("gate: build");
    await expect(
      access(join(dir, ".github", "workflows", "rivetari.yml.bak")),
    ).rejects.toThrow();
  });

  it("--force keeps a customised rivetari.yml and writes the template beside it", async () => {
    const dir = await tmp();
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runInit(dir, { type: "cli", yes: true }, { token: null });
    const wf = (...p: string[]) => join(dir, ".github", "workflows", ...p);
    const custom =
      "name: rivetari\r\non: [pull_request]\njobs:\n  rivetari:\n    uses: ./packages/action\n";
    await writeFile(wf("rivetari.yml"), custom);

    const fresh = await tmp();
    await runInit(
      fresh,
      { type: "cli", phase: "build", yes: true },
      { token: null },
    );
    const template = await readFile(
      join(fresh, ".github", "workflows", "rivetari.yml"),
      "utf8",
    );

    out.mockClear();
    expect(
      await runInit(
        dir,
        { type: "cli", phase: "build", yes: true, force: true },
        { token: null },
      ),
    ).toBe(0);
    expect(await readFile(wf("rivetari.yml"), "utf8")).toBe(custom);
    const sibling = await readFile(wf("rivetari.rivetari.yml"), "utf8");
    expect(sibling).toContain("gate: build");
    expect(sibling).toBe(template);
    await expect(access(wf("rivetari.yml.bak"))).rejects.toThrow();

    const said = out.mock.calls.join("");
    expect(said).toContain(".github/workflows/rivetari.rivetari.yml");
    expect(said).toContain("merge it by hand");
  });

  it("writes rivetari.yml from the template when there's none, with or without --force", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const wf = (...p: string[]) => join(dir, ".github", "workflows", ...p);
    await runInit(dir, { type: "cli", yes: true }, { token: null });
    const template = await readFile(wf("rivetari.yml"), "utf8");
    expect(template).toContain("name: rivetari");
    expect(template).toContain("gate: scaffold");
    await expect(access(wf("rivetari.rivetari.yml"))).rejects.toThrow();

    await rm(wf("rivetari.yml"));
    await runInit(
      dir,
      { type: "cli", yes: true, force: true },
      { token: null },
    );
    expect(await readFile(wf("rivetari.yml"), "utf8")).toBe(template);
    await expect(access(wf("rivetari.rivetari.yml"))).rejects.toThrow();
    await expect(access(wf("rivetari.yml.bak"))).rejects.toThrow();
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInit(dir, { type: "cli", yes: true }, { token: null });
    const code = await runInit(
      dir,
      { type: "library", yes: true },
      { token: null },
    );
    expect(code).toBe(1);
  });

  it("requires --type in non-interactive mode", async () => {
    const dir = await tmp();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runInit(dir, { yes: true }, { token: null });
    expect(code).toBe(1);
  });
});
