import { resolve } from "node:path";

import {
  type CaseRun,
  type EvalResult,
  runJudgeEval,
} from "@arynbht/rivetari-runtime";
import pc from "picocolors";

export interface JudgeEvalFlags {
  cases?: string;
  case?: string[];
  out?: string;
  label?: string;
  model?: string;
  /** Commander's `--no-review`: false judges tier 1 alone, with no model calls. */
  review?: boolean;
  concurrency?: string;
  json?: boolean;
  color?: boolean;
}

/**
 * `rivetari judge eval`: judge every labelled case in the corpus with today's
 * judge and report caught, missed and false blocks, with per-case detail and
 * a JSON result. Exits 0 when every case was judged, 1 when any errored.
 */
export async function runJudgeEvalCommand(
  flags: JudgeEvalFlags,
): Promise<number> {
  const casesDir = resolve(flags.cases ?? "eval/cases");
  const concurrency = flags.concurrency ? Number(flags.concurrency) : undefined;
  if (concurrency !== undefined && !(concurrency >= 1)) {
    console.error("rivetari judge eval: --concurrency must be 1 or more");
    return 1;
  }
  let outcome;
  try {
    outcome = await runJudgeEval({
      casesDir,
      only: flags.case,
      outDir: resolve(flags.out ?? "eval/results"),
      label: flags.label,
      tier2: flags.review !== false,
      model: flags.model,
      concurrency,
      log: flags.json
        ? undefined
        : (line) => process.stderr.write(`· ${line}\n`),
    });
  } catch (err) {
    console.error(`rivetari judge eval: ${(err as Error).message}`);
    return 1;
  }
  const { result, file } = outcome;
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const color = flags.color !== false && process.stdout.isTTY === true;
    process.stdout.write(`${renderEval(result, color)}\n`);
    if (file) process.stdout.write(`\nResult: ${file}\n`);
  }
  return result.summary.errors > 0 ? 1 : 0;
}

const MARK: Record<CaseRun["outcome"], string> = {
  caught: "caught",
  "blocked-other": "blocked, other reason",
  missed: "MISSED",
  pass: "pass",
  "false-block": "FALSE BLOCK",
  held: "held for a person",
  "not-reviewed": "not reviewed",
  error: "ERROR",
};

export function renderEval(result: EvalResult, color: boolean): string {
  const c = pc.createColors(color);
  const s = result.summary;
  const paint = (o: CaseRun["outcome"]) =>
    o === "caught" || o === "pass"
      ? c.green(MARK[o])
      : o === "missed" || o === "false-block" || o === "error"
        ? c.red(MARK[o])
        : c.yellow(MARK[o]);
  const lines = [
    `Judge eval · ${result.cases.length} case(s) · ${result.tier2 ? "tier 1 and tier 2" : "tier 1 only"}${result.commit ? ` · ${result.commit.slice(0, 12)}` : ""}`,
    "",
  ];
  for (const r of result.cases) {
    const verdict = r.verdict ?? "no verdict";
    const where = r.caughtBy ? ` · pilot: caught by ${r.caughtBy}` : "";
    lines.push(
      `${r.id.padEnd(30)} ${paint(r.outcome)} · ${verdict}${r.why ? ` (${r.why})` : ""}${where}`,
    );
    if (r.matched.length > 0)
      lines.push(c.dim(`    matched: ${r.matched.join(", ")}`));
    for (const f of r.review?.blocking ?? [])
      lines.push(
        c.dim(
          `    blocking ${f.kind}${f.acceptance_id ? ` (${f.acceptance_id})` : ""}: ${f.title}`,
        ),
      );
    for (const a of (r.review?.acceptance ?? []).filter(
      (a) => a.status !== "met",
    ))
      lines.push(c.dim(`    ${a.id} ${a.status}: ${a.note.slice(0, 160)}`));
    const t1 = r.tier1?.checks ?? [];
    const by = (src: string) => t1.filter((ch) => ch.source === src).length;
    if (r.tier1)
      lines.push(
        c.dim(
          `    tier 1 ${r.tier1.verdict}: ${by("live")} live, ${by("recorded")} recorded, ${by("not run")} not run${r.review ? ` · review ${r.review.model}${r.review.effort ? ` (${r.review.effort})` : ""} $${r.review.costUsd.toFixed(2)}` : ""}`,
        ),
      );
    for (const note of r.notes) lines.push(c.dim(`    note: ${note}`));
    if (r.error) lines.push(c.red(`    error: ${r.error}`));
  }
  lines.push(
    "",
    `Defects: ${s.caught}/${s.defects} caught · ${s.missed} missed · ${s.blockedOther} blocked for another reason`,
    `Clean:   ${s.passed}/${s.clean} passed · ${s.falseBlocks} false block(s) · ${s.held} held for a person`,
    `${s.notReviewed ? `${s.notReviewed} not reviewed · ` : ""}${s.errors} error(s) · ${s.tokens} tokens · $${s.costUsd.toFixed(2)} · ${Math.round(s.durationMs / 1000)}s of judging`,
  );
  return lines.join("\n");
}
