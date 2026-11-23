import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ControlResult, ControlStatus } from "@arynbht/rivetari-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { comparePr, exitCodeForPr, prBaseSha, runCi } from "./ci.js";

const run = promisify(execFile);

function result(controlId: string, status: ControlStatus): ControlResult {
  return {
    controlId,
    title: controlId,
    lane: "hygiene",
    phase: "scaffold",
    severity: "medium",
    effort: "small",
    status,
    detectors: [{ status: status === "fail" ? "fail" : "pass", message: "" }],
    durationMs: 0,
  };
}

describe("comparePr", () => {
  it("blames a PR only for a control that passed or was n/a at base", () => {
    const base = [
      result("a", "pass"),
      result("b", "fail"),
      result("c", "n/a"),
      result("d", "pass"),
    ];
    const head = [
      result("a", "fail"),
      result("b", "fail"),
      result("c", "fail"),
      result("d", "pass"),
    ];
    const comparison = comparePr(base, head);
    expect(comparison.regressions.map((r) => r.controlId)).toEqual(["a", "c"]);
    expect(comparison.preExisting.map((r) => r.controlId)).toEqual(["b"]);
    expect(comparison.added).toEqual([]);
    expect(exitCodeForPr(comparison)).toBe(1);
  });

  it("passes a PR whose failures were all failing at base", () => {
    const comparison = comparePr(
      [result("b", "fail"), result("w", "waived")],
      [result("b", "fail"), result("w", "fail")],
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.preExisting.map((r) => r.controlId)).toEqual(["b", "w"]);
    expect(exitCodeForPr(comparison)).toBe(0);
  });

  it("doesn't count a control that wasn't checked at base", () => {
    const comparison = comparePr([], [result("new", "fail")]);
    expect(comparison.added.map((r) => r.controlId)).toEqual(["new"]);
    expect(exitCodeForPr(comparison)).toBe(0);
  });

  it("ignores a head status that doesn't turn the gate red", () => {
    const comparison = comparePr(
      [result("a", "pass")],
      [result("a", "needs-evidence")],
    );
    expect(exitCodeForPr(comparison)).toBe(0);
  });
});

describe("runCi on a pull request", () => {
  const made: string[] = [];
  const ENV_KEYS = [
    "GITHUB_REPOSITORY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "RIVETARI_GATE",
    "GITHUB_WORKSPACE",
    "GITHUB_EVENT_PATH",
    "GITHUB_STEP_SUMMARY",
  ];
  let saved: Record<string, string | undefined>;
  let output: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await run("git", args, { cwd });
    return stdout.trim();
  }

  /** A repo with a README at base; `change` makes the PR's commit on top. */
  async function prRepo(
    change: (dir: string) => Promise<void>,
  ): Promise<{ dir: string; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-ci-pr-"));
    made.push(dir);
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "ci@example.com");
    await git(dir, "config", "user.name", "ci");
    await git(dir, "config", "commit.gpgsign", "false");
    await writeFile(join(dir, "README.md"), "# fixture\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await change(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "head");

    const summary = join(dir, "..", `${dir.split(/[\\/]/).pop()}-summary.md`);
    made.push(summary);
    const event = join(dir, "..", `${dir.split(/[\\/]/).pop()}-event.json`);
    made.push(event);
    await writeFile(
      event,
      JSON.stringify({ pull_request: { number: 7, base: { sha: base } } }),
    );
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_EVENT_PATH = event;
    process.env.GITHUB_STEP_SUMMARY = summary;
    process.env.RIVETARI_GATE = "build";
    vi.mocked(console.error).mockImplementation((line: unknown) => {
      output += `${String(line)}\n`;
    });
    return { dir, base };
  }

  it("passes a PR that leaves an already-red gate no worse", async () => {
    // The fixture fails plenty of build-gate controls at base already.
    await prRepo(async (dir) => {
      await writeFile(join(dir, "notes.md"), "notes\n");
    });
    expect(await runCi()).toBe(0);
    expect(output).not.toContain("whole repo is judged");
  });

  it("fails a PR that breaks a control that passed at base", async () => {
    const { dir } = await prRepo(async (d) => {
      await rm(join(d, "README.md"));
    });
    expect(await runCi()).toBe(1);
    const summary = await readFile(
      join(dir, "..", `${dir.split(/[\\/]/).pop()}-summary.md`),
      "utf8",
    );
    expect(summary).toContain(
      "Failing because of this PR: `repo.readme.present`",
    );
    // The throwaway base worktree is gone.
    expect(await git(dir, "worktree", "list")).not.toContain("rivetari-base-");
  });

  it("reads the base from a merge commit's first parent", async () => {
    const { dir, base } = await prRepo(async () => undefined);
    const head = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "--detach", base);
    await git(dir, "merge", "-q", "--no-ff", "-m", "merge", head);
    expect(await prBaseSha(dir, null)).toBe(base);
  });

  it("falls back to the event's base sha outside a merge commit", async () => {
    const { dir, base } = await prRepo(async () => undefined);
    expect(
      await prBaseSha(dir, { pull_request: { base: { sha: base } } }),
    ).toBe(base);
  });
});
