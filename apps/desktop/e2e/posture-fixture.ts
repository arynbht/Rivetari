import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A repo for the Posture tab, written the way the CLI and CI write it: an
// audit recorded in state.json, posture snapshots in history.jsonl (two from
// before CI recorded status counts, two after, and a task row that isn't a
// snapshot), waivers (one expired, one expiring soon, one active) and evidence.
// The profile declares scaffold, whose gate is green, so the controls put the
// repo at build, held there by two controls before harden. It's a git repo so
// drafting a card can reserve an id on the tasks branch.

export const WHO = "e2e@example.com";

const DAY = 86_400_000;
const day = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const control = (
  id: string,
  status: string,
  lane: string,
  phase: string,
  severity: string,
) => ({ id, status, lane, phase, severity });

export const RECORDED = [
  control("ci.workflow.present", "pass", "cicd", "scaffold", "high"),
  control("ci.runs-on-pr", "pass", "cicd", "scaffold", "high"),
  control("dev.env-example", "waived", "development", "scaffold", "low"),
  control("ci.changelog-automated", "fail", "cicd", "build", "low"),
  control(
    "a11y.keyboard.manual-pass",
    "needs-evidence",
    "accessibility",
    "build",
    "high",
  ),
  control("ci.actions-pinned-sha", "fail", "cicd", "harden", "medium"),
  control("product.discovery.brief", "fail", "product", "discovery", "medium"),
  control(
    "a11y.ci.automated-checks",
    "n/a",
    "accessibility",
    "build",
    "medium",
  ),
];

/** What `rivetari audit` would count for RECORDED. */
export const TOTALS = {
  Pass: 2,
  Fail: 3,
  "Needs evidence": 1,
  Waived: 1,
  Skipped: 0,
  "N/A": 1,
  Total: 8,
};

export const WAIVERS = [
  "- control: product.discovery.brief",
  "  reason: Shipped product; the brief predates Rivetari",
  "  owner: ann@example.com",
  `  created: ${day(-120)}`,
  `  expires: ${day(-30)}`,
  "- control: dev.env-example",
  "  reason: No environment variables yet",
  "  owner: bo@example.com",
  `  created: ${day(-20)}`,
  `  expires: ${day(10)}`,
  "- control: ci.actions-pinned-sha",
  "  reason: Renovate pins actions from next sprint",
  `  expires: ${day(200)}`,
  "",
].join("\n");

const EVIDENCE = [
  "- control: a11y.keyboard.manual-pass",
  "  reviewer: bo@example.com",
  `  date: ${day(-400)}`,
  "  valid-for: 90d",
  "  note: Keyboard pass on the settings flow",
  "- control: a11y.screen-reader.pass",
  "  reviewer: cy@example.com",
  `  date: ${day(-5)}`,
  "  valid-for: 30d",
  "  url: https://example.com/screen-reader-notes",
  "",
].join("\n");

const lanes = (pass: number, total: number) => ({
  cicd: { pass, total },
});

const HISTORY = [
  { date: day(-21), byLane: lanes(1, 6) },
  { date: day(-14), byLane: lanes(2, 6) },
  {
    kind: "task",
    task: "T-0099",
    pr: 12,
    closed: day(-10),
  },
  {
    date: day(-7),
    byLane: lanes(3, 7),
    summary: {
      pass: 2,
      fail: 4,
      needsEvidence: 1,
      waived: 0,
      skip: 0,
      na: 1,
      total: 8,
    },
  },
  {
    date: day(0),
    byLane: lanes(3, 7),
    summary: {
      pass: 2,
      fail: 3,
      needsEvidence: 1,
      waived: 1,
      skip: 0,
      na: 1,
      total: 8,
    },
  },
];

export function postureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-posture-"));
  const dir = join(repo, ".rivetari");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# posture fixture\n");
  writeFileSync(
    join(dir, "profile.yml"),
    "version: 1\nname: posture-repo\ntype: cli\nstack:\n  - typescript\nflags: {}\nphase: scaffold\nseverity-floor: low\n",
  );
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      version: 1,
      generatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      summary: {
        pass: 2,
        fail: 3,
        needsEvidence: 1,
        waived: 1,
        skip: 0,
        na: 1,
        total: 8,
      },
      controls: RECORDED,
    }),
  );
  writeFileSync(
    join(dir, "history.jsonl"),
    `${HISTORY.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeFileSync(join(dir, "waivers.yml"), WAIVERS);
  writeFileSync(join(dir, "evidence.yml"), EVIDENCE);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", WHO);
  git("config", "user.name", "E2E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}
