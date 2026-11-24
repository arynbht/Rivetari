import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Profile } from "@arynbht/rivetari-catalog";
import { autonomyLedger, type TaskView } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProject,
  type Detected,
  otherFlags,
  parseGap,
  projectFields,
  readAutonomy,
  readRecords,
  readSkills,
  routeGaps,
} from "./project";

// The Project view holds profile.yml against what the repo shows, with init's
// detectors, and reads the autonomy ledger, skills and banned patterns
// without writing anything.

const profile = (over: Partial<Profile> = {}): Profile => ({
  version: 1,
  name: "shop",
  type: "web-app",
  stack: ["typescript"],
  flags: {},
  "severity-floor": "low",
  autonomy: "supervised",
  phase: "build",
  ...over,
});

const detected = (over: Partial<Detected> = {}): Detected => ({
  name: "shop",
  type: "web-app",
  stacks: ["node", "typescript"],
  packageManager: "pnpm",
  flags: [],
  phase: { inferred: "build", recordedAt: "2026-11-23T09:00:00.000Z" },
  ...over,
});

const byKey = (fields: ReturnType<typeof projectFields>) =>
  new Map(fields.map((f) => [f.key, f]));

describe("projectFields", () => {
  it("finds nothing to change when the profile matches the repo", () => {
    const fields = projectFields(profile(), detected());
    expect(fields.filter((f) => f.differs)).toEqual([]);
    expect(fields.map((f) => f.key)).toEqual([
      "name",
      "type",
      "stack",
      "package-manager",
      "phase",
      "flags.uses-ai",
      "flags.open-source",
      "flags.distributes-binaries",
    ]);
  });

  it("adds the stacks the manifests show and drops ones nothing shows, keeping free text", () => {
    const fields = byKey(
      projectFields(
        profile({ stack: ["python", "postgres"] }),
        detected({ stacks: ["node"] }),
      ),
    );
    expect(fields.get("stack")).toMatchObject({
      declared: "python, postgres",
      detected: "node",
      differs: true,
      change: { path: "stack", from: "python, postgres", to: "postgres, node" },
    });
    expect(fields.get("stack")?.evidence).toBe(
      "The manifests show node, which profile.yml doesn't name. Nothing in the repo shows python.",
    );
  });

  it("leaves the stack alone when the repo has no manifest to read", () => {
    const fields = byKey(
      projectFields(profile({ stack: ["go"] }), detected({ stacks: [] })),
    );
    expect(fields.get("stack")).toMatchObject({
      detected: null,
      differs: false,
    });
  });

  it("holds the package manager against proof.start, and rewrites only its runner", () => {
    const fields = byKey(
      projectFields(
        profile({ proof: { start: "npm run dev", ready_timeout: 180 } }),
        detected(),
      ),
    );
    expect(fields.get("package-manager")).toMatchObject({
      declared: "npm",
      detected: "pnpm",
      change: { path: "proof.start", from: "npm run dev", to: "pnpm run dev" },
    });
    // No proof.start: the profile names no package manager, so nothing differs.
    expect(
      byKey(projectFields(profile(), detected())).get("package-manager"),
    ).toMatchObject({ declared: null, differs: false });
  });

  it("suggests the phase the recorded controls give, and only when one is recorded", () => {
    const behind = byKey(
      projectFields(
        profile({ phase: "scaffold" }),
        detected({
          phase: { inferred: "build", recordedAt: "2026-11-23T09:00:00Z" },
        }),
      ),
    );
    expect(behind.get("phase")).toMatchObject({
      declared: "scaffold",
      detected: "build",
      change: { path: "phase", from: "scaffold", to: "build" },
      evidence:
        "Where the controls in the audit recorded 2026-11-23 put the repo.",
    });
    const none = byKey(
      projectFields(profile({ phase: "scaffold" }), detected({ phase: null })),
    );
    expect(none.get("phase")).toMatchObject({ detected: null, differs: false });
  });

  it("suggests a flag the repo shows, never takes one off, and leaves a type it can't read", () => {
    const fields = byKey(
      projectFields(
        profile({ flags: { "open-source": true } }),
        detected({
          type: null,
          flags: [
            { flag: "uses-ai", evidence: "package.json depends on openai" },
          ],
        }),
      ),
    );
    expect(fields.get("flags.uses-ai")).toMatchObject({
      declared: "not set",
      detected: "shown",
      evidence: "package.json depends on openai",
      change: { path: "flags.uses-ai", from: "not set", to: "true" },
    });
    expect(fields.get("flags.open-source")).toMatchObject({
      declared: "set",
      detected: "not shown",
      differs: false,
    });
    expect(fields.get("type")).toMatchObject({
      declared: "web-app",
      detected: null,
      differs: false,
    });
  });

  it("tells names apart only when they differ beyond case", () => {
    expect(
      byKey(
        projectFields(profile({ name: "Shop" }), detected({ name: "shop" })),
      ).get("name")?.differs,
    ).toBe(false);
    expect(
      byKey(
        projectFields(profile({ name: "shop" }), detected({ name: "store" })),
      ).get("name")?.change,
    ).toEqual({ path: "name", from: "shop", to: "store" });
  });

  it("lists the flags no file can show apart", () => {
    expect(
      otherFlags(
        profile({
          flags: { "has-users": true, "uses-ai": true, "eu-users": false },
        }),
      ),
    ).toEqual(["has-users"]);
  });
});

describe("route gaps", () => {
  const routed = (id: string, gaps: string[]): TaskView =>
    ({
      id,
      done: false,
      assemblyText: [
        `task: ${id}`,
        "sectors: [ui]",
        "phases: [build]",
        "skills: []",
        "spine: []",
        "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
        "checks: [quality.lint.clean]",
        "proof: ui-screenshots",
        "review: { rubric: default, design_pass: false, security: false }",
        "stop_and_ask: []",
        `gaps: [${gaps.map((g) => JSON.stringify(g)).join(", ")}]`,
        "",
      ].join("\n"),
    }) as TaskView;

  it("splits a gap into its sector and the router's reason", () => {
    expect(
      parseGap(
        "motion: no vendored skill covers it; the agent works from the spine",
      ),
    ).toEqual({
      sector: "motion",
      reason: "no vendored skill covers it; the agent works from the spine",
    });
    expect(parseGap("no vendored skill covers motion")).toEqual({
      sector: null,
      reason: "no vendored skill covers motion",
    });
  });

  it("names each gap once, with the tasks that hit it, newest first", () => {
    const gap = "motion: no vendored skill covers it";
    expect(
      routeGaps([
        routed("T-0001", [gap]),
        routed("T-0003", [gap, "legal: no vendored skill covers it"]),
        { id: "T-0002", done: false } as TaskView,
      ]),
    ).toEqual([
      {
        sector: "motion",
        reason: "no vendored skill covers it",
        tasks: ["T-0003", "T-0001"],
      },
      {
        sector: "legal",
        reason: "no vendored skill covers it",
        tasks: ["T-0003"],
      },
    ]);
  });
});

describe("against a repo on disk", () => {
  let repo = "";
  const savedKey = process.env.RIVETARI_LEDGER_KEY;
  const write = async (rel: string, text: string) => {
    await mkdir(dirname(join(repo, rel)), { recursive: true });
    await writeFile(join(repo, rel), text);
  };
  const sha256 = (data: string | Buffer) =>
    createHash("sha256").update(data).digest("hex");

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-project-"));
    process.env.RIVETARI_LEDGER_KEY = "ef".repeat(32);
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
    else process.env.RIVETARI_LEDGER_KEY = savedKey;
    await rm(repo, { recursive: true, force: true });
  });

  it("checks an out-of-date profile with init's detectors and the recorded audit", async () => {
    await write(
      ".rivetari/profile.yml",
      "version: 1\nname: shop\ntype: library\nstack: []\nflags: {}\nphase: scaffold\n",
    );
    await write(
      "package.json",
      JSON.stringify({
        name: "@acme/shop",
        dependencies: { react: "19", openai: "4" },
      }),
    );
    await write(
      ".rivetari/state.json",
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-23T09:00:00.000Z",
        summary: {},
        controls: [
          {
            id: "ci.workflow.present",
            status: "pass",
            lane: "cicd",
            phase: "scaffold",
            severity: "high",
          },
          {
            id: "ci.changelog-automated",
            status: "fail",
            lane: "cicd",
            phase: "build",
            severity: "low",
          },
        ],
      }),
    );
    const before = await readFile(
      join(repo, ".rivetari", "profile.yml"),
      "utf8",
    );
    const check = await checkProject(
      repo,
      new Date("2026-11-24T10:00:00.000Z"),
    );
    expect(check.checkedAt).toBe("2026-11-24T10:00:00.000Z");
    expect(check.profileFound).toBe(true);
    const changes = check.fields.flatMap((f) => (f.change ? [f.change] : []));
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: "type", from: "library", to: "web-app" },
        { path: "stack", from: "none", to: "node" },
        { path: "flags.uses-ai", from: "not set", to: "true" },
      ]),
    );
    expect(byKey(check.fields).get("name")?.detected).toBe("shop");
    expect(byKey(check.fields).get("package-manager")?.detected).toBe("npm");
    // The check reads; profile.yml is as it was.
    expect(await readFile(join(repo, ".rivetari", "profile.yml"), "utf8")).toBe(
      before,
    );
  });

  it("says when there's no profile, and changes nothing", async () => {
    const check = await checkProject(repo);
    expect(check.profileFound).toBe(false);
    expect(check.problems[0]).toMatch(/no \.rivetari\/profile\.yml/);
    expect(check.fields.some((f) => f.differs)).toBe(false);
  });

  it("reads the autonomy ledger's entries without rewriting its view", async () => {
    const ledger = await autonomyLedger(repo);
    await ledger.append({
      beat: "route",
      section: "decision",
      text: "autonomy review-at-pr · override · rules 12 · reason: trial run",
      by: "ann@example.com",
    });
    const view = join(repo, ".rivetari", "autonomy", "ledger.md");
    // Hand-edit the rendered view: ladder() would repair it, this doesn't.
    await writeFile(view, "edited\n");
    const autonomy = await readAutonomy(repo, "review-at-pr");
    expect(autonomy.configured).toBe("review-at-pr");
    expect(autonomy.entries).toEqual([
      expect.objectContaining({
        level: "review-at-pr",
        kind: "override",
        rules: 12,
        note: "reason: trial run",
        by: "ann@example.com",
      }),
    ]);
    expect(autonomy.problems[0]).toMatch(/ledger\.md doesn't match/);
    expect(await readFile(view, "utf8")).toBe("edited\n");
  });

  it("hides entries whose seals don't verify", async () => {
    const ledger = await autonomyLedger(repo);
    await ledger.append({
      beat: "route",
      section: "decision",
      text: "autonomy supervised · lowered · rules 3",
      by: "ann@example.com",
    });
    const jsonl = join(repo, ".rivetari", "autonomy", "ledger.jsonl");
    await writeFile(
      jsonl,
      (await readFile(jsonl, "utf8")).replace("lowered", "earned"),
    );
    const autonomy = await readAutonomy(repo, "supervised");
    expect(autonomy.entries).toEqual([]);
    expect(autonomy.problems[0]).toMatch(/doesn't verify/);
  });

  it("reads each locked skill's state after the last sync", async () => {
    const pin = "a".repeat(40);
    const skillMd = "# ui-kit\n";
    const hash = `sha256:${sha256(Buffer.concat([Buffer.from("SKILL.md\0"), Buffer.from(skillMd)]))}`;
    const lock = [
      "version: 1",
      "skills:",
      `  - { name: ui-kit, source: acme/skills/ui-kit, pin: "${pin}", hash: "${hash}", scope: always }`,
      `  - { name: api-docs, source: acme/skills/api-docs, pin: "${pin}", hash: "sha256:${"b".repeat(64)}", scope: always }`,
      `  - { name: motion, source: acme/skills/motion, pin: "${pin}", hash: "sha256:${"c".repeat(64)}", scope: task }`,
      "",
    ].join("\n");
    await write(".rivetari/skills.lock", lock);
    await write(".agents/skills/ui-kit/SKILL.md", skillMd);
    await write(
      ".rivetari/skills.state.json",
      JSON.stringify({
        syncedAt: "2026-11-22T10:00:00.000Z",
        lock: sha256(lock),
        skills: [
          {
            name: "ui-kit",
            pin,
            hash,
            scope: "always",
            installed: true,
            from: "cache",
          },
          {
            name: "motion",
            pin,
            hash: `sha256:${"c".repeat(64)}`,
            scope: "task",
            installed: false,
            from: "cache",
          },
        ],
        blocked: [],
      }),
    );
    const skills = await readSkills(repo, []);
    expect(skills.error).toBeNull();
    expect(skills.syncedAt).toBe("2026-11-22T10:00:00.000Z");
    expect(skills.installed).toBe(1);
    expect(skills.locked.map((s) => [s.name, s.state, s.detail])).toEqual([
      ["ui-kit", "installed", null],
      ["api-docs", "not-installed", "api-docs is not installed"],
      ["motion", "per-task", "fetched when a route picks it"],
    ]);
    expect(skills.problems).toEqual([]);
  });

  it("reads banned patterns, proof settings without auth's value, and an open profile task", async () => {
    await write(
      ".rivetari/profile.yml",
      [
        "version: 1",
        "name: shop",
        "type: web-app",
        "flags: {}",
        "proof:",
        "  start: pnpm run dev",
        "  ready_timeout: 180",
        "  auth:",
        "    script: scripts/sign-in.mjs",
        "",
      ].join("\n"),
    );
    await write(
      ".rivetari/banned.json",
      JSON.stringify({
        version: 1,
        patterns: [
          {
            id: "no-moment",
            pattern: "from ['\"]moment['\"]",
            why: "moment is retired here; use date-fns",
            source: "judge finding T-0004",
          },
        ],
      }),
    );
    const records = await readRecords(repo, [
      {
        id: "T-0005",
        title: "Update profile.yml: stack",
        done: false,
        card: { touches: [".rivetari/profile.yml"] },
      } as unknown as TaskView,
    ]);
    expect(records.proof).toEqual({
      start: "pnpm run dev",
      url: null,
      readyTimeout: 180,
      auth: true,
    });
    expect(JSON.stringify(records.proof)).not.toContain("sign-in.mjs");
    expect(records.banned).toEqual({
      patterns: [
        {
          id: "no-moment",
          pattern: "from ['\"]moment['\"]",
          files: "**/*",
          why: "moment is retired here; use date-fns",
          source: "judge finding T-0004",
        },
      ],
      error: null,
    });
    expect(records.openTask).toEqual({
      id: "T-0005",
      title: "Update profile.yml: stack",
    });
    expect(records.autonomy).toEqual({
      configured: "supervised",
      entries: [],
      problems: [],
    });
  });

  it("says a banned.json that doesn't parse, beside what does", async () => {
    await write(".rivetari/banned.json", "{ not json");
    const records = await readRecords(repo, []);
    expect(records.banned.patterns).toEqual([]);
    expect(records.banned.error).toMatch(/banned\.json can't be read/);
    expect(records.proof).toBeNull();
  });
});
