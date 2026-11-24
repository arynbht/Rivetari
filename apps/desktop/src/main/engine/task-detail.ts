// Task detail adapter: one task in full for the Tasks tab, read from the
// records. The card, the route and the plan come from the watcher's view of
// the task (the hub's); every judge round and the proof come from this
// machine's `.rivetari/tasks/<id>/` (round files and proof never go to the
// tasks branch), each round checked against the hash its verdict sealed, by
// the runtime. A criterion's status is the latest round's word on it, or a
// person's answer to the judge's question about it. Nothing here writes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  allowedDecisions,
  APPROVED,
  type Card,
  type Finding,
  type JudgeRound,
  type LedgerEntry,
  loadJudgeRounds,
  parseAssembly,
  type ProofRecord,
  sha256,
  taskPlan,
  TASKS_DIR,
  type TaskView,
} from "@arynbht/rivetari-runtime";

import type {
  TaskCriterion,
  TaskDetail,
  TaskFinding,
  TaskJudgeRound,
  TaskProof,
  TaskProofShot,
} from "../../shared/ipc";
import { assemblyOf, routeReasons } from "./now";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const ASKED_UNVERIFIED = "asked: unverified_acceptance: ";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each criterion's status after the latest judge round: met or unmet as the
 * review reported it; hand-checked when the judge asked about it as
 * unverified and a person allowed that; unverified otherwise, silence
 * included (the judge counts it the same way). Before any round, not judged.
 */
export function criteriaStatus(
  card: Pick<Card, "acceptance">,
  rounds: JudgeRound[],
  entries: LedgerEntry[],
): { judgedRound: number | null; acceptance: TaskCriterion[] } {
  const latest = rounds.at(-1);
  const of = (
    a: Card["acceptance"][number],
    status: TaskCriterion["status"],
    note: string,
  ): TaskCriterion => ({
    id: a.id,
    text: a.text,
    verify: a.verify,
    status,
    note,
  });
  if (!latest)
    return {
      judgedRound: null,
      acceptance: card.acceptance.map((a) => of(a, "not judged", "")),
    };
  const reported = new Map(
    (latest.record?.review?.acceptance ?? []).map((a) => [a.id, a]),
  );
  // The judge's latest question about unverified criteria, if a person
  // allowed it; a round sent back to build is judged again, so it doesn't count.
  const asked = entries
    .filter((e) => e.section === "stop" && e.text.startsWith(ASKED_UNVERIFIED))
    .at(-1)
    ?.text.slice("asked: ".length);
  const allowed =
    asked === undefined || latest.verdict === "failed"
      ? undefined
      : allowedDecisions({ entries }).findLast((d) => d.asked === asked);
  const handChecked = (id: string) =>
    allowed !== undefined &&
    new RegExp(`(?:^|; )${escape(id)} \\(`).test(
      allowed.asked.slice("unverified_acceptance: ".length),
    );
  const unread =
    latest.record === null
      ? `round ${latest.round}'s record can't be read: ${latest.problem ?? "unknown"}`
      : latest.record.review === undefined
        ? `the review didn't run in round ${latest.round} (tier 1: ${latest.record.tier1.verdict})`
        : null;
  return {
    judgedRound: latest.round,
    acceptance: card.acceptance.map((a) => {
      const r = reported.get(a.id);
      if (r && (r.status === "met" || r.status === "unmet"))
        return of(a, r.status, r.note ?? "");
      if (allowed && handChecked(a.id))
        return of(
          a,
          "hand-checked",
          `allowed by ${allowed.by}${allowed.note ? `: ${allowed.note}` : ""}`,
        );
      return of(
        a,
        "unverified",
        unread ??
          (r
            ? r.note || "no reason given"
            : "the reviewer didn't report on it"),
      );
    }),
  };
}

const findingOf = (f: Finding): TaskFinding => ({
  kind: f.kind,
  title: f.title,
  file: f.file || null,
  line: f.line ?? null,
  acceptanceId: f.acceptance_id ?? null,
  detail: f.detail ?? "",
  repro: f.repro ?? "",
  fix: f.fix ?? "",
  downgraded: f.downgraded ?? null,
});

/** A judge round as the detail shows it: tier 1's checks, then the review. */
export function roundView(r: JudgeRound): TaskJudgeRound {
  const base = {
    round: r.round,
    verdict: r.verdict,
    at: r.at,
    head: null,
    tier1: null,
    review: null,
    risk: null,
  };
  const record = r.record;
  if (!record) return { ...base, problem: r.problem };
  try {
    return {
      ...base,
      problem: null,
      head: record.head,
      tier1: {
        verdict: record.tier1.verdict,
        checks: record.tier1.checks
          .filter((c) => c.outcome !== "n/a")
          .map((c) => ({
            id: c.id,
            title: c.title,
            outcome: c.outcome,
            message: c.message,
          })),
        protectedPaths: record.tier1.protected.map(
          (p) => `${p.path}: ${p.detail}`,
        ),
        notes: record.tier1.notes,
      },
      review: record.review
        ? {
            verdict: record.review.verdict,
            model: record.review.model,
            blocking: record.review.blocking.map(findingOf),
            suggestions: record.review.suggestions.map(findingOf),
            acceptance: record.review.acceptance.map((a) => ({
              id: a.id,
              status: a.status,
              note: a.note ?? "",
            })),
            unreviewed: record.review.unreviewed,
          }
        : null,
      risk: record.risk
        ? {
            card: record.risk.card,
            effective: record.risk.effective,
            reasons: record.risk.reasons,
          }
        : null,
    };
  } catch (err) {
    // A record from an older runtime can lack a part this reads.
    return {
      ...base,
      problem: `round ${r.round}'s record isn't one this version can read: ${message(err)}`,
    };
  }
}

/** A PNG's width and height from its header, or null when it isn't a PNG. */
export function pngSize(
  data: Buffer,
): { width: number; height: number } | null {
  const signature = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== signature)
    return null;
  if (data.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** A screenshot bigger than this is listed, not shown. */
export const MAX_SHOT_BYTES = 4 * 1024 * 1024;
/** How much of test-run.txt is shown: its end, where a failure is. */
export const TEST_RUN_CHARS = 64_000;

export interface DetailDeps {
  loadJudgeRounds: typeof loadJudgeRounds;
  readFile: (path: string) => Promise<Buffer>;
}

const detailDeps: DetailDeps = {
  loadJudgeRounds,
  readFile: (path) => readFile(path),
};

const missing = (err: unknown) =>
  (err as NodeJS.ErrnoException).code === "ENOENT";

/** One screenshot, read from the proof directory by its file name alone. */
async function shotOf(
  dir: string,
  shot: NonNullable<ProofRecord["shots"]>[number],
  deps: DetailDeps,
): Promise<TaskProofShot> {
  // The record names the file where it was shot; only its name is trusted,
  // so nothing outside the proof directory is read.
  const file = shot.file.split(/[\\/]/).pop() ?? "";
  const base = {
    side: shot.side,
    page: shot.page,
    breakpoint: shot.breakpoint,
    status: shot.status,
    file,
    bytes: null,
    width: null,
    height: null,
    dataUrl: null,
  };
  if (!/^[\w.-]+\.png$/i.test(file))
    return { ...base, problem: `${file || shot.file} isn't a PNG file name` };
  let data: Buffer;
  try {
    data = await deps.readFile(join(dir, file));
  } catch (err) {
    return {
      ...base,
      problem: missing(err)
        ? "not on this machine"
        : `can't be read: ${message(err)}`,
    };
  }
  const size = pngSize(data);
  if (!size)
    return { ...base, bytes: data.length, problem: "isn't a PNG image" };
  const shown = data.length <= MAX_SHOT_BYTES;
  return {
    ...base,
    bytes: data.length,
    ...size,
    dataUrl: shown ? `data:image/png;base64,${data.toString("base64")}` : null,
    problem: shown
      ? null
      : `too large to show here (${(data.length / 1024 / 1024).toFixed(1)} MB)`,
  };
}

/** The prove beat's record on this machine, with its test run and screenshots. */
export async function readProof(
  repoPath: string,
  id: string,
  deps: DetailDeps = detailDeps,
): Promise<TaskDetail["proof"]> {
  const dir = join(repoPath, TASKS_DIR, id, "proof");
  const where = `${TASKS_DIR}/${id}/proof`;
  let record: ProofRecord;
  try {
    record = JSON.parse(
      (await deps.readFile(join(dir, "proof.json"))).toString("utf8"),
    ) as ProofRecord;
  } catch (err) {
    if (missing(err)) return { record: null, error: null };
    return {
      record: null,
      error: `can't read ${where}/proof.json: ${message(err)}`,
    };
  }
  let testRun: string | null = null;
  let error: string | null = null;
  try {
    const text = (await deps.readFile(join(dir, "test-run.txt"))).toString(
      "utf8",
    );
    testRun =
      text.length > TEST_RUN_CHARS ? `…${text.slice(-TEST_RUN_CHARS)}` : text;
  } catch (err) {
    if (!missing(err))
      error = `can't read ${where}/test-run.txt: ${message(err)}`;
  }
  try {
    const shots = await Promise.all(
      (record.shots ?? []).map((s) => shotOf(dir, s, deps)),
    );
    const proof: TaskProof = {
      kind: String(record.kind),
      passed: record.passed === true,
      lines: record.lines ?? [],
      tests: record.tests
        ? {
            exitCode: record.tests.exitCode,
            added: record.tests.added ?? [],
            outcome: record.tests.outcome ?? null,
          }
        : null,
      violations: (record.violations ?? []).map((v) => ({
        id: v.id,
        impact: v.impact,
        page: v.page,
        nodes: v.nodes,
      })),
      shots,
      testRun,
      ui: record.kind === "ui-screenshots" || shots.length > 0,
    };
    return { record: proof, error };
  } catch (err) {
    return {
      record: null,
      error: `${where}/proof.json isn't a proof record this version can read: ${message(err)}`,
    };
  }
}

/** Everything the detail shows of task `view`, each part failing on its own. */
export async function taskDetail(
  repoPath: string,
  view: TaskView,
  deps: DetailDeps = detailDeps,
): Promise<TaskDetail> {
  const judge = await deps
    .loadJudgeRounds(repoPath, { card: { id: view.id }, entries: view.entries })
    .then(
      (rounds) => ({ rounds, error: null }),
      (err: unknown) => ({
        rounds: [] as JudgeRound[],
        error: `the judge's rounds can't be read: ${message(err)}`,
      }),
    );
  const card = view.card;
  const criteria = card
    ? criteriaStatus(card, judge.rounds, view.entries)
    : null;

  const text = view.assemblyText;
  let route: TaskDetail["route"] = null;
  if (text !== undefined) {
    const { assembly, problems } = parseAssembly(text);
    const hash = sha256(text);
    route = {
      assembly: assembly ? assemblyOf(assembly) : null,
      problems,
      reasons: routeReasons(view.entries),
      approved: view.entries.some(
        (e) => e.beat === "route" && APPROVED.exec(e.text)?.[1] === hash,
      ),
    };
  }

  return {
    id: view.id,
    title: view.title,
    card:
      card && criteria
        ? {
            description: card.description,
            type: card.type,
            risk: card.risk,
            outOfScope: card.out_of_scope,
            touches: card.touches,
            acceptance: criteria.acceptance,
          }
        : null,
    judgedRound: criteria?.judgedRound ?? null,
    route,
    plan: taskPlan(view),
    judge: { rounds: judge.rounds.map(roundView), error: judge.error },
    proof: await readProof(repoPath, view.id, deps),
  };
}
