// A card's risk is derived from what it touches: high and medium signals are
// generic globs (plus the repo's sensitive list), everything else is low
// whatever the file count, and a declared risk can only raise it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveRisk, higherRisk, intakeRiskNote } from "./risk.js";
import { newTask } from "./tasks.js";

const risk = (...paths: string[]) => deriveRisk({ paths }).risk;

describe("deriveRisk", () => {
  it.each([
    ["signing or key handling", "src/signing/notarize.js"],
    ["signing or key handling", "scripts/codesign-mac.sh"],
    ["signing or key handling", "src/ledger-key.ts"],
    ["leases", "src/lease.ts"],
    ["leases", "packages/runtime/src/task/task-lease.ts"],
    ["the autonomy ledger", "packages/runtime/src/task/ledger.ts"],
    ["the autonomy ledger", ".rivetari/autonomy/ledger.jsonl"],
    ["auth, billing or payments", "src/auth/login.ts"],
    ["auth, billing or payments", "lib/payments/stripe.ts"],
    ["auth, billing or payments", "src/billing.ts"],
    ["a migration or schema", "db/migrations/001_init.sql"],
    ["a migration or schema", "prisma/schema.prisma"],
    ["a migration or schema", "packages/catalog/src/schema.ts"],
    ["infrastructure as code", "infra/main.tf"],
    ["infrastructure as code", "Dockerfile"],
    ["secrets handling", ".env.production"],
    ["secrets handling", "config/credentials.json"],
    ["secrets handling", "deploy/id_rsa"],
  ])("high: %s (%s)", (what, path) => {
    const derived = deriveRisk({ paths: [path, "src/other.ts"] });
    expect(derived.risk).toBe("high");
    expect(derived.reasons).toContain(`high: ${what} (${path})`);
  });

  it.each([
    ["CI or workflow config", ".github/workflows/ci.yml"],
    ["CI or workflow config", "lefthook.yml"],
    ["dependencies or a lockfile", "pnpm-lock.yaml"],
    ["dependencies or a lockfile", "packages/cli/package.json"],
    ["dependencies or a lockfile", "requirements-dev.txt"],
    ["lint or tsconfig config", "tsconfig.base.json"],
    ["lint or tsconfig config", "packages/x/eslint.config.js"],
  ])("medium: %s (%s)", (what, path) => {
    const derived = deriveRisk({ paths: [path] });
    expect(derived.risk).toBe("medium");
    expect(derived.reasons).toEqual([`medium: ${what} (${path})`]);
  });

  it("medium: the repo's sensitive list", () => {
    expect(
      deriveRisk({ paths: ["src/core/engine.ts"], sensitive: ["src/core/**"] }),
    ).toEqual({
      risk: "medium",
      reasons: ["medium: the repo's sensitive list (src/core/engine.ts)"],
    });
  });

  it("medium: existing tests the card doesn't name", () => {
    expect(
      deriveRisk({ paths: ["src/a.test.ts"], unnamedTests: ["src/a.test.ts"] }),
    ).toEqual({
      risk: "medium",
      reasons: ["medium: existing tests the card doesn't name (src/a.test.ts)"],
    });
  });

  it("is low for everything else, however many files", () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/feature/f${i}.ts`);
    expect(deriveRisk({ paths: many })).toEqual({ risk: "low", reasons: [] });
    expect(deriveRisk({ paths: [] })).toEqual({ risk: "low", reasons: [] });
  });

  it("isn't fooled by words that only contain a signal", () => {
    expect(
      risk(
        "src/release.ts",
        "src/design.ts",
        "src/author.ts",
        "src/keyboard.ts",
        "src/monkey.ts",
        "docs/please.md",
      ),
    ).toBe("low");
  });

  it("reads lease, signing and key code from the changed lines", () => {
    const lines = (text: string) => new Map([["src/store.ts", [text]]]);
    for (const line of [
      "const LEASE_MS = 30 * 60_000;",
      "await localLease(repo, id);",
      "export async function takeLease() {",
      "createHmac('sha256', key)",
    ])
      expect(
        deriveRisk({ paths: ["src/store.ts"], lines: lines(line) }).reasons,
      ).toEqual(["high: lease, signing or key code (src/store.ts)"]);
    for (const line of ["await release(tag);", "RELEASE_NOTES", "please"])
      expect(
        deriveRisk({ paths: ["src/store.ts"], lines: lines(line) }).risk,
      ).toBe("low");
    // Prose about leases isn't lease code.
    expect(
      deriveRisk({
        paths: ["docs/x.md"],
        lines: new Map([["docs/x.md", ["the lease expires"]]]),
      }).risk,
    ).toBe("low");
  });

  it("lists the highest signals first and caps the paths it names", () => {
    const derived = deriveRisk({
      paths: [
        "pnpm-lock.yaml",
        "src/auth/a.ts",
        "src/auth/b.ts",
        "src/auth/c.ts",
        "src/auth/d.ts",
      ],
    });
    expect(derived.reasons).toEqual([
      "high: auth, billing or payments (src/auth/a.ts, src/auth/b.ts, src/auth/c.ts, and 1 more)",
      "medium: dependencies or a lockfile (pnpm-lock.yaml)",
    ]);
  });

  it("higherRisk picks the higher", () => {
    expect(higherRisk("low", "medium")).toBe("medium");
    expect(higherRisk("high", "low")).toBe("high");
    expect(higherRisk("medium", "medium")).toBe("medium");
  });

  it("a declared risk raises the derived one and never lowers it", () => {
    const low = { risk: "low" as const, reasons: [] };
    const medium = {
      risk: "medium" as const,
      reasons: ["medium: CI or workflow config (.github/workflows/ci.yml)"],
    };
    expect(intakeRiskNote(low, undefined)).toBe(
      "risk low: no high or medium signal in the touches",
    );
    expect(intakeRiskNote(low, "high")).toBe(
      "risk high: declared high, raised from low (no high or medium signal in the touches)",
    );
    expect(intakeRiskNote(medium, "low")).toBe(
      "risk medium: derived from the touches: medium: CI or workflow config (.github/workflows/ci.yml) (the declared low can't lower it)",
    );
  });
});

describe("risk at intake", () => {
  const made: string[] = [];
  const by = { by: "dev@example.com", now: new Date("2026-11-20T10:00:00Z") };
  const saved = process.env.RIVETARI_CONFIG_DIR;
  let repo: string;
  beforeEach(async () => {
    const config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
    repo = await mkdtemp(join(tmpdir(), "rivetari-risk-"));
    made.push(config, repo);
    process.env.RIVETARI_CONFIG_DIR = config;
    const git = simpleGit(repo);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    for (const path of ["src/total.js", "src/billing/invoice.js"]) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), "module.exports = {};\n");
    }
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.RIVETARI_CONFIG_DIR;
    else process.env.RIVETARI_CONFIG_DIR = saved;
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });

  const draft = (extra: Record<string, unknown>) =>
    newTask(
      repo,
      {
        title: "Fix total",
        type: "fix",
        description: "total should sum.",
        acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
        ...extra,
      },
      by,
    );
  const note = (task: Awaited<ReturnType<typeof draft>>) =>
    task.entries.find((e) => e.beat === "intake" && e.section === "decision")
      ?.text;

  it("derives low from ordinary touches and records why", async () => {
    const task = await draft({ touches: ["src/total.js"] });
    expect(task.card.risk).toBe("low");
    expect(note(task)).toBe(
      "risk low: no high or medium signal in the touches",
    );
  });

  it("derives high from a sensitive touch, and from a glob that matches one", async () => {
    const named = await draft({ touches: ["src/billing/invoice.js"] });
    expect(named.card.risk).toBe("high");
    expect(note(named)).toBe(
      "risk high: derived from the touches: high: auth, billing or payments (src/billing/invoice.js)",
    );
    const globbed = await draft({ touches: ["src/**/*.js"] });
    expect(globbed.card.risk).toBe("high");
  });

  it("lets a declared risk raise it, never lower it", async () => {
    const raised = await draft({ touches: ["src/total.js"], risk: "high" });
    expect(raised.card.risk).toBe("high");
    expect(note(raised)).toMatch(/^risk high: declared high, raised from low/);
    const kept = await draft({
      touches: ["src/billing/invoice.js"],
      risk: "low",
    });
    expect(kept.card.risk).toBe("high");
    expect(note(kept)).toMatch(/the declared low can't lower it\)$/);
  });
});
