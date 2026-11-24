import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readRecordedAudit,
  summarizeResults,
  writeAuditState,
} from "./audit-record.js";
import type { ControlResult } from "./evaluate.js";

function result(
  controlId: string,
  status: ControlResult["status"],
  severity: ControlResult["severity"] = "medium",
): ControlResult {
  return {
    controlId,
    title: controlId,
    lane: "hygiene",
    phase: "build",
    severity,
    effort: "small",
    status,
    detectors: [],
    durationMs: 0,
  };
}

let repo = "";

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rivetari-audit-record-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("summarizeResults", () => {
  it("counts every status and the total", () => {
    expect(
      summarizeResults([
        result("a", "pass"),
        result("b", "fail"),
        result("c", "fail"),
        result("d", "needs-evidence"),
        result("e", "waived"),
        result("f", "skip"),
        result("g", "n/a"),
      ]),
    ).toEqual({
      pass: 1,
      fail: 2,
      needsEvidence: 1,
      waived: 1,
      skip: 1,
      na: 1,
      total: 7,
    });
  });
});

describe("writeAuditState and readRecordedAudit", () => {
  it("reads back what the audit recorded", async () => {
    const results = [
      result("repo.readme.present", "pass", "low"),
      result("repo.license.present", "fail", "high"),
      result("sec.threat-model", "needs-evidence"),
    ];
    await writeAuditState(repo, results);

    const recorded = await readRecordedAudit(repo);
    expect(recorded).not.toBe(null);
    expect(recorded?.controls).toEqual([
      {
        id: "repo.readme.present",
        status: "pass",
        lane: "hygiene",
        phase: "build",
        severity: "low",
      },
      {
        id: "repo.license.present",
        status: "fail",
        lane: "hygiene",
        phase: "build",
        severity: "high",
      },
      {
        id: "sec.threat-model",
        status: "needs-evidence",
        lane: "hygiene",
        phase: "build",
        severity: "medium",
      },
    ]);
    expect(recorded?.summary).toEqual(summarizeResults(results));
    expect(Date.parse(recorded?.generatedAt ?? "")).not.toBeNaN();

    // The file holds the same summary the reader counts.
    const raw = JSON.parse(
      await readFile(join(repo, ".rivetari", "state.json"), "utf8"),
    ) as { summary: unknown };
    expect(raw.summary).toEqual(recorded?.summary);
  });

  it("keeps the managed-file registry that `rivetari fix` wrote", async () => {
    await mkdir(join(repo, ".rivetari"), { recursive: true });
    await writeFile(
      join(repo, ".rivetari", "state.json"),
      JSON.stringify({ version: 1, managed: { "SECURITY.md": "abc" } }),
    );
    await writeAuditState(repo, [result("a", "pass")]);
    const raw = JSON.parse(
      await readFile(join(repo, ".rivetari", "state.json"), "utf8"),
    ) as { managed: unknown };
    expect(raw.managed).toEqual({ "SECURITY.md": "abc" });
  });

  it("returns null when no audit has been recorded", async () => {
    expect(await readRecordedAudit(repo)).toBe(null);

    // A state file with only fix's registry has no audit in it either.
    await mkdir(join(repo, ".rivetari"), { recursive: true });
    await writeFile(
      join(repo, ".rivetari", "state.json"),
      JSON.stringify({ version: 1, managed: {} }),
    );
    expect(await readRecordedAudit(repo)).toBe(null);
  });

  it("leaves out entries it can't read and counts the rest", async () => {
    await mkdir(join(repo, ".rivetari"), { recursive: true });
    await writeFile(
      join(repo, ".rivetari", "state.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-23T02:17:38.576Z",
        summary: { total: 99 },
        controls: [
          { id: "a", status: "fail", lane: "hygiene", phase: "build" },
          { id: "b", status: "bogus" },
          "c",
          { status: "pass" },
        ],
      }),
    );
    const recorded = await readRecordedAudit(repo);
    expect(recorded?.generatedAt).toBe("2026-11-23T02:17:38.576Z");
    expect(recorded?.controls.map((c) => c.id)).toEqual(["a"]);
    expect(recorded?.summary.total).toBe(1);
    expect(recorded?.summary.fail).toBe(1);
  });
});
