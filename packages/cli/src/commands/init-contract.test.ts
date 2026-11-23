import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "./init.js";
import {
  parseActionRef,
  renderRivetariWorkflow,
  resolveReleasePin,
} from "./init-action.js";
import { CLAUDE_MD, houseRulesFrom } from "./init-files.js";

const SHA = "466fcf18a98307f2e2982f15c5bcbe2178282243";
const PIN = { sha: SHA, tag: "v1.0.0" };

describe(
  "init's contract files, .gitattributes and action pin",
  { timeout: 30_000 },
  () => {
    const made: string[] = [];
    afterEach(async () => {
      for (const d of made) await rm(d, { recursive: true, force: true });
      made.length = 0;
      vi.restoreAllMocks();
    });
    const tmp = async (): Promise<string> => {
      const d = await mkdtemp(join(tmpdir(), "rivetari-init-contract-"));
      made.push(d);
      return d;
    };
    const read = (dir: string, ...p: string[]) =>
      readFile(join(dir, ...p), "utf8");
    const quiet = () =>
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const pinned = {
      token: null,
      resolveActionPin: () => Promise.resolve(PIN),
    };

    it("moves a CLAUDE.md's rules into AGENTS.md's This repo section and points CLAUDE.md at it", async () => {
      const dir = await tmp();
      const out = quiet();
      await writeFile(
        join(dir, "CLAUDE.md"),
        [
          "# CLAUDE.md",
          "",
          "## Conventions",
          "",
          "- All money is integer cents.",
          "- Run `make db` before tests.",
          "",
          "```sh",
          "# not a heading",
          "```",
          "",
        ].join("\r\n"),
      );
      expect(await runInit(dir, { type: "web-app", yes: true }, pinned)).toBe(
        0,
      );
      const agents = await read(dir, "AGENTS.md");
      const thisRepo = agents.slice(agents.indexOf("## This repo"));
      expect(thisRepo).toContain("#### Conventions");
      expect(thisRepo).toContain("- All money is integer cents.");
      expect(thisRepo).toContain("```sh\n# not a heading\n```");
      expect(thisRepo).not.toContain("# CLAUDE.md");
      expect(await read(dir, "CLAUDE.md")).toBe(CLAUDE_MD);
      expect(out.mock.calls.join("")).toContain(
        'moved the rules in CLAUDE.md into AGENTS.md\'s "This repo" section',
      );
    });

    it("leaves CLAUDE.md alone when the repo's own AGENTS.md stays", async () => {
      const dir = await tmp();
      quiet();
      await writeFile(join(dir, "AGENTS.md"), "# Ours\n");
      await writeFile(join(dir, "CLAUDE.md"), "Use tabs.\n");
      await runInit(dir, { type: "cli", yes: true }, pinned);
      expect(await read(dir, "AGENTS.md")).toBe("# Ours\n");
      expect(await read(dir, "CLAUDE.md")).toBe("Use tabs.\n");
      expect(await read(dir, "AGENTS.rivetari.md")).toContain("Use tabs.");
      expect(await read(dir, "CLAUDE.rivetari.md")).toBe(CLAUDE_MD);
    });

    it("adds the .rivetari LF line to .gitattributes once, keeping what's there", async () => {
      const fresh = await tmp();
      quiet();
      await runInit(fresh, { type: "cli", yes: true }, pinned);
      expect(await read(fresh, ".gitattributes")).toBe(
        ".rivetari/** text eol=lf\n",
      );

      const dir = await tmp();
      await writeFile(
        join(dir, ".gitattributes"),
        "* text=auto\r\n*.png binary",
      );
      await runInit(dir, { type: "cli", yes: true }, pinned);
      const once =
        "* text=auto\r\n*.png binary\r\n.rivetari/** text eol=lf\r\n";
      expect(await read(dir, ".gitattributes")).toBe(once);
      await runInit(dir, { type: "cli", yes: true, force: true }, pinned);
      expect(await read(dir, ".gitattributes")).toBe(once);
    });

    it("pins the action to a commit SHA with the tag as a comment", async () => {
      const dir = await tmp();
      quiet();
      await runInit(dir, { type: "cli", yes: true }, pinned);
      const wf = await read(dir, ".github", "workflows", "rivetari.yml");
      expect(wf).toContain(
        `- uses: arynbht/rivetari/packages/action@${SHA} # v1.0.0`,
      );
      expect(wf).not.toMatch(/@v\d/);
      expect(wf).not.toContain("not pinned");
    });

    it("offline, writes a workflow that fails saying so, and --action-ref replaces it", async () => {
      const dir = await tmp();
      const out = quiet();
      expect(
        await runInit(dir, { type: "cli", yes: true }, { token: null }),
      ).toBe(0);
      const wfPath = join(dir, ".github", "workflows", "rivetari.yml");
      const offline = await readFile(wfPath, "utf8");
      expect(offline).not.toMatch(
        /^\s*- uses: arynbht\/rivetari\/packages\/action@/m,
      );
      expect(offline).not.toMatch(/@v\d/);
      expect(offline).toContain("::error::rivetari init could not pin");
      const said = out.mock.calls.join("");
      expect(said).toContain(
        "couldn't pin the Rivetari action to a commit (init ran offline)",
      );
      expect(said).toContain("--action-ref <sha>");

      expect(
        await runInit(
          dir,
          { type: "cli", yes: true, force: true, actionRef: `${SHA}:v1.0.0` },
          { token: null },
        ),
      ).toBe(0);
      expect(await readFile(wfPath, "utf8")).toContain(
        `packages/action@${SHA} # v1.0.0`,
      );
      await expect(
        access(join(dir, ".github", "workflows", "rivetari.rivetari.yml")),
      ).rejects.toThrow();
    });

    it("refuses an --action-ref that isn't a commit SHA, before writing anything", async () => {
      const dir = await tmp();
      const err = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      expect(
        await runInit(
          dir,
          { type: "cli", yes: true, actionRef: "v1" },
          { token: null },
        ),
      ).toBe(1);
      expect(err.mock.calls.join("")).toContain(
        "--action-ref takes a 40-hex commit SHA",
      );
      await expect(access(join(dir, ".rivetari"))).rejects.toThrow();
    });
  },
);

describe("houseRulesFrom", () => {
  it("drops the title and any init's pointer lines, and is null when nothing's left", () => {
    expect(houseRulesFrom(CLAUDE_MD)).toBeNull();
    expect(houseRulesFrom("# CLAUDE.md\n\n@AGENTS.md\n")).toBeNull();
    expect(houseRulesFrom("# Project\n\n###### Deep\ntext\n")).toBe(
      "### Project\n\n###### Deep\ntext",
    );
  });
});

describe("the action pin", () => {
  it("parses --action-ref", () => {
    expect(parseActionRef(SHA.toUpperCase())).toEqual({
      sha: SHA,
      tag: "pinned with --action-ref",
    });
    expect(parseActionRef(`${SHA}:v1.2.0`)).toEqual({
      sha: SHA,
      tag: "v1.2.0",
    });
    expect(parseActionRef("v1")).toBeNull();
    expect(parseActionRef(SHA.slice(1))).toBeNull();
  });

  const fakeGitHub = (routes: Record<string, unknown>) =>
    vi.fn((url: string) => {
      const path = url.replace(
        "https://api.github.com/repos/arynbht/rivetari",
        "",
      );
      const body = routes[path];
      return Promise.resolve(
        new Response(body === undefined ? "{}" : JSON.stringify(body), {
          status: body === undefined ? 404 : 200,
        }),
      );
    }) as unknown as typeof fetch;

  it("resolves the CLI's own release tag, through an annotated tag", async () => {
    const fetch = fakeGitHub({
      "/git/ref/tags/v1.2.0": { object: { type: "tag", sha: "t".repeat(40) } },
      [`/git/tags/${"t".repeat(40)}`]: { object: { type: "commit", sha: SHA } },
    });
    expect(await resolveReleasePin({ version: "1.2.0", fetch })).toEqual({
      sha: SHA,
      tag: "v1.2.0",
    });
  });

  it("falls back to the latest release when the CLI's tag isn't there", async () => {
    const fetch = fakeGitHub({
      "/releases/latest": { tag_name: "v1.0.0" },
      "/git/ref/tags/v1.0.0": { object: { type: "commit", sha: SHA } },
    });
    expect(await resolveReleasePin({ version: "9.9.9", fetch })).toEqual(PIN);
  });

  it("says why when there's nothing to pin to", async () => {
    await expect(
      resolveReleasePin({ version: "9.9.9", fetch: fakeGitHub({}) }),
    ).rejects.toThrow("has no tag v9.9.9 and no latest release");
    const down = vi.fn(() =>
      Promise.resolve(new Response("", { status: 503 })),
    ) as unknown as typeof fetch;
    await expect(
      resolveReleasePin({ version: "1.0.0", fetch: down }),
    ).rejects.toThrow("HTTP 503");
  });

  it("renders the gate into both jobs", () => {
    const wf = renderRivetariWorkflow("build", PIN);
    expect(wf.match(/gate: build/g)).toHaveLength(2);
  });
});
