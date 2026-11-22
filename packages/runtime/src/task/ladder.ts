import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Autonomy } from "@arynbht/factory-catalog";
import { loadProfile, saveProfile } from "@arynbht/factory-engine";
import { simpleGit } from "simple-git";

import { loadBanned } from "../judge/banned.js";
import { findingsMetrics, historyRows } from "../judge/findings.js";
import type { TaskHistoryRow } from "../ship/close.js";
import { Ledger } from "./ledger.js";
import { TaskError } from "./tasks.js";

export const AUTONOMY_DIR = ".factory/autonomy";
const RANK: Record<Autonomy, number> = {
  supervised: 0,
  "review-at-pr": 1,
  unattended: 2,
};
const BELOW: Record<Autonomy, Autonomy> = {
  supervised: "supervised",
  "review-at-pr": "supervised",
  unattended: "review-at-pr",
};
const ENTRY =
  /^autonomy (supervised|review-at-pr|unattended) · (override|earned|lowered|fell back) · rules (\d+)(?: · (.*))?$/;
const DAY = 24 * 60 * 60_000;

export interface AutonomyEntry {
  level: Autonomy;
  kind: "override" | "earned" | "lowered" | "fell back";
  rules: number;
  note: string;
  at: string;
  by: string;
}

export interface RuleCount {
  checks: number;
  diff: number;
  boundaries: number;
  lint: number;
  banned: number;
  total: number;
}

export interface LadderNumbers {
  rules: RuleCount;
  rulesAtEntry: number | null;
  last10: { prs: number; blockingPerPr: number | null };
  firstPass: { merged: number; rate: number | null };
  sinceEntry: { prs: number; blocking: number };
  reverts: string[];
  rejection: { prs: number; rate: number | null };
}

export interface LadderState {
  configured: Autonomy;
  effective: Autonomy;
  entry: AutonomyEntry | null;
  entries: AutonomyEntry[];
  numbers: LadderNumbers;
  unmet: Record<Autonomy, string[]>;
  fallback: string | null;
}

export const autonomyLedger = (repoPath: string) =>
  Ledger.open(join(repoPath, AUTONOMY_DIR), "Autonomy");

export async function autonomyEntries(
  repoPath: string,
): Promise<AutonomyEntry[]> {
  const ledger = await autonomyLedger(repoPath);
  return (await ledger.entries()).flatMap((e) => {
    const m = ENTRY.exec(e.text);
    return m
      ? [
          {
            level: m[1] as Autonomy,
            kind: m[2] as AutonomyEntry["kind"],
            rules: Number(m[3]),
            note: m[4] ?? "",
            at: e.at,
            by: e.by,
          },
        ]
      : [];
  });
}

async function firstText(
  repoPath: string,
  names: string[],
): Promise<string | null> {
  for (const name of names) {
    const text = await readFile(join(repoPath, name), "utf8").catch(() => null);
    if (text !== null) return text;
  }
  return null;
}

export async function ruleCount(repoPath: string): Promise<RuleCount> {
  const { tier1Rules } = await findingsMetrics(repoPath, []);
  const cruiser = await firstText(repoPath, [
    ".dependency-cruiser.mjs",
    ".dependency-cruiser.cjs",
    ".dependency-cruiser.js",
    ".dependency-cruiser.json",
  ]);
  const boundaries = cruiser
    ? (cruiser.match(/["']?\bname["']?\s*:\s*["'][^"']+["']/g) ?? []).length
    : 0;
  const eslint = await firstText(repoPath, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
  ]);
  const lint = new Set(
    [...(eslint ?? "").matchAll(/["']factory\/([a-z0-9-]+)["']\s*:/g)]
      .map((m) => m[1])
      .filter((name) => name !== "no-banned"),
  ).size;
  const banned =
    (await loadBanned(repoPath).catch(() => null))?.patterns.filter(
      (p) => p.covered_by === undefined,
    ).length ?? 0;
  return {
    checks: tier1Rules.catalog,
    diff: tier1Rules.diff,
    boundaries,
    lint,
    banned,
    total: tier1Rules.total + boundaries + lint + banned,
  };
}

async function revertedPrs(
  repoPath: string,
  rows: TaskHistoryRow[],
): Promise<string[]> {
  const git = simpleGit(repoPath);
  let log = "";
  for (const ref of ["origin/HEAD", "origin/main", "HEAD"]) {
    log = await git
      .raw(["log", "-n", "500", "--format=%s%x00%cI", ref])
      .catch(() => "");
    if (log) break;
  }
  const reverts = log
    .split("\n")
    .map((line) => line.split("\0"))
    .flatMap(([subject, at]) => {
      const pr = subject?.match(/^Revert ".*\(#(\d+)\)"/)?.[1];
      return pr && at ? [{ pr: Number(pr), at: Date.parse(at) }] : [];
    });
  return rows.flatMap((row) => {
    const hit = reverts.find(
      (r) =>
        r.pr === row.pr &&
        r.at - Date.parse(row.date) <= 7 * DAY &&
        r.at >= Date.parse(row.date) - DAY,
    );
    return hit ? [`#${row.pr} (${row.task}) reverted within 7 days`] : [];
  });
}

const blocking = (row: TaskHistoryRow) =>
  (row.findings ?? []).filter((f) => f.kind !== "suggestion").length;

export async function ladder(
  repoPath: string,
  options: { rows?: TaskHistoryRow[] | undefined; now?: Date | undefined } = {},
): Promise<LadderState> {
  const now = options.now ?? new Date();
  const profile = await loadProfile(repoPath).catch(() => null);
  const configured: Autonomy = profile?.autonomy ?? "supervised";
  const entries = await autonomyEntries(repoPath);
  const entry =
    [...entries].reverse().find((e) => e.level === configured) ?? null;
  const rows = (options.rows ?? (await historyRows(repoPath))).filter(
    (r) => r.pr !== null,
  );
  const reviewed = rows.filter((r) => r.findings !== undefined);
  const last10 = reviewed.slice(-10);
  const merged = rows.filter((r) => r.outcome === "merged").slice(-10);
  const since = entry
    ? reviewed.filter((r) => r.date >= entry.at.slice(0, 10))
    : [];
  const window = since.slice(-5);
  const decided = rows
    .filter((r) => r.outcome === "merged" || r.outcome === "closed")
    .slice(-20);
  const rules = await ruleCount(repoPath);
  const numbers: LadderNumbers = {
    rules,
    rulesAtEntry: entry?.rules ?? null,
    last10: {
      prs: last10.length,
      blockingPerPr:
        last10.length > 0
          ? last10.reduce((n, r) => n + blocking(r), 0) / last10.length
          : null,
    },
    firstPass: {
      merged: merged.length,
      rate:
        merged.length > 0
          ? merged.filter((r) => r.judge_rounds === 1).length / merged.length
          : null,
    },
    sinceEntry: {
      prs: window.length,
      blocking: window.reduce((n, r) => n + blocking(r), 0),
    },
    reverts: await revertedPrs(
      repoPath,
      entry ? rows.filter((r) => r.date >= entry.at.slice(0, 10)) : [],
    ),
    rejection: {
      prs: decided.length,
      rate:
        decided.length > 0
          ? decided.filter((r) => r.outcome === "closed").length /
            decided.length
          : null,
    },
  };

  const reviewAtPrUnmet: string[] = [];
  const doubled =
    numbers.rulesAtEntry !== null && rules.total >= 2 * numbers.rulesAtEntry;
  if (rules.total < 20 && !doubled)
    reviewAtPrUnmet.push(
      `tier 1 rules ${rules.total}: needs 20, or double the ${numbers.rulesAtEntry ?? "count"} at entry`,
    );
  if (numbers.last10.prs < 10)
    reviewAtPrUnmet.push(
      `${numbers.last10.prs} of 10 reviewed PRs needed for findings per PR`,
    );
  else if ((numbers.last10.blockingPerPr ?? 0) > 0.5)
    reviewAtPrUnmet.push(
      `blocking findings per PR ${numbers.last10.blockingPerPr?.toFixed(2)}: needs 0.5 or fewer`,
    );
  if (numbers.firstPass.merged < 10)
    reviewAtPrUnmet.push(
      `${numbers.firstPass.merged} of 10 merged PRs needed for first-pass merge rate`,
    );
  else if ((numbers.firstPass.rate ?? 0) < 0.8)
    reviewAtPrUnmet.push(
      `first-pass merge ${Math.round((numbers.firstPass.rate ?? 0) * 100)}%: needs 80%`,
    );

  const unattendedUnmet: string[] = [];
  const atReview =
    configured === "review-at-pr" && entry
      ? (now.getTime() - Date.parse(entry.at)) / DAY
      : 0;
  if (atReview < 28)
    unattendedUnmet.push(
      `review-at-pr held ${Math.floor(atReview)} of 28 days`,
    );
  unattendedUnmet.push("smell counts aren't measured yet");
  unattendedUnmet.push("the sampled-read slop rate isn't measured yet");

  let fallback: string | null = null;
  if (configured !== "supervised" && numbers.reverts.length > 0)
    fallback = numbers.reverts.join("; ");
  else if (configured === "review-at-pr" && numbers.sinceEntry.blocking > 5)
    fallback = `${numbers.sinceEntry.blocking} blocking findings over ${numbers.sinceEntry.prs} PR(s) since entering review-at-pr: more than 1 per PR over five`;
  else if (
    configured === "unattended" &&
    numbers.rejection.prs >= 20 &&
    (numbers.rejection.rate ?? 0) > 0.05
  )
    fallback = `rejection rate ${Math.round((numbers.rejection.rate ?? 0) * 100)}% over 20 PRs`;

  const latest = entries.at(-1);
  const logged =
    latest?.kind === "fell back" &&
    RANK[latest.level] < RANK[configured] &&
    (!entry || Date.parse(latest.at) >= Date.parse(entry.at));
  const effective = logged
    ? (latest?.level ?? configured)
    : fallback
      ? BELOW[configured]
      : configured;

  return {
    configured,
    effective,
    entry,
    entries,
    numbers,
    unmet: {
      supervised: [],
      "review-at-pr": reviewAtPrUnmet,
      unattended: unattendedUnmet,
    },
    fallback: logged ? (latest?.note ?? fallback) : fallback,
  };
}

async function record(
  repoPath: string,
  level: Autonomy,
  kind: AutonomyEntry["kind"],
  rules: number,
  note: string,
  by: string,
  now?: Date,
): Promise<void> {
  const ledger = await autonomyLedger(repoPath);
  await ledger.append({
    beat: "route",
    section: kind === "fell back" ? "outcome" : "decision",
    text: `autonomy ${level} · ${kind} · rules ${rules}${note ? ` · ${note}` : ""}`,
    by,
    at: now,
  });
}

export async function setAutonomy(
  repoPath: string,
  level: Autonomy,
  options: {
    by: string;
    override?: string | undefined;
    now?: Date | undefined;
  },
): Promise<{ state: LadderState; kind: AutonomyEntry["kind"] | null }> {
  const profile = await loadProfile(repoPath);
  if (!profile)
    throw new TaskError(
      "No .factory/profile.yml found. Run `factory init` to create one.",
    );
  const before = await ladder(repoPath, { now: options.now });
  const override = options.override?.replace(/\s+/g, " ").trim();
  let kind: AutonomyEntry["kind"] | null;
  if (RANK[level] < RANK[before.effective]) kind = "lowered";
  else if (level === before.effective && level === before.configured)
    kind = override ? "override" : null;
  else if (before.unmet[level].length === 0) kind = "earned";
  else if (override) kind = "override";
  else
    throw new TaskError(
      `${level} isn't earned yet: ${before.unmet[level].join("; ")}. Raise it anyway with --override "<why>"; the reason goes in ${AUTONOMY_DIR}/ledger.md`,
    );
  if (kind === null) return { state: before, kind };
  if (profile.autonomy !== level)
    await saveProfile(repoPath, { ...profile, autonomy: level });
  await record(
    repoPath,
    level,
    kind,
    before.numbers.rules.total,
    kind === "override" ? `reason: ${override}` : "",
    options.by,
    options.now,
  );
  return { state: await ladder(repoPath, { now: options.now }), kind };
}

export async function enforceFallback(
  repoPath: string,
  options: { by: string; now?: Date | undefined },
): Promise<LadderState> {
  const state = await ladder(repoPath, { now: options.now });
  const latest = state.entries.at(-1);
  const already =
    latest?.kind === "fell back" && latest.level === state.effective;
  if (state.fallback && state.effective !== state.configured && !already)
    await record(
      repoPath,
      state.effective,
      "fell back",
      state.numbers.rules.total,
      state.fallback,
      options.by,
      options.now,
    );
  return ladder(repoPath, { now: options.now });
}
