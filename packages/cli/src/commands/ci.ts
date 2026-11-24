import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type Control,
  type Gate,
  loadBundledCatalog,
  loadBundledGates,
  SEVERITIES,
} from "@arynbht/rivetari-catalog";
import {
  appendHistory,
  buildContext,
  ciBudgetSection,
  type ControlResult,
  evaluateControls,
  evaluateGate,
  EvidenceError,
  evidenceExpiringWithin,
  type GateStatus,
  laneCounts,
  Octokit,
  QUIET_LOG,
  ProfileError,
  resolveToken,
  selectForGate,
  summarizeResults,
  upsertStatusIssue,
  upsertStickyComment,
  WaiverError,
  waiversExpiringWithin,
} from "@arynbht/rivetari-engine";
import { compareResults } from "@arynbht/rivetari-runtime";

import { today } from "../dates.js";
import { renderReport } from "../report.js";

const run = promisify(execFile);

interface EventPayload {
  pull_request?: {
    number?: number;
    base?: { sha?: string };
    head?: { sha?: string };
  };
  number?: number;
}

async function readEvent(): Promise<EventPayload | null> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as EventPayload;
  } catch {
    return null;
  }
}

/** Fail the job only on a pull request with a red gate. */
export function exitCodeForCi(isPr: boolean, gateStatus: GateStatus): number {
  return isPr && gateStatus === "red" ? 1 : 0;
}

/** The gate's failing controls at head, sorted by what they were at base. */
export interface PrComparison {
  /** Passed, or was n/a, at base and fails now: this PR broke it. */
  regressions: ControlResult[];
  /** Already not passing at base; reported, not blamed on this PR. */
  preExisting: ControlResult[];
  /**
   * No result at base at all. Both sides are evaluated with one catalog, so
   * every control has one today; this keeps a control missing from the base
   * results from being blamed on the PR.
   */
  added: ControlResult[];
}

/**
 * Compare the gate's controls at base and head with the judge's tier 1 rule, so
 * a PR is blamed only for what it made worse. Only a head `fail` counts, as it's
 * the only status that turns the gate red.
 */
export function comparePr(
  baseResults: ControlResult[],
  headResults: ControlResult[],
): PrComparison {
  const failing = headResults.filter((r) => r.status === "fail");
  const atBase = new Set(baseResults.map((r) => r.controlId));
  const added = failing.filter((r) => !atBase.has(r.controlId));
  const known = failing.filter((r) => atBase.has(r.controlId));
  const outcomes = new Map(
    compareResults(baseResults, known).map((o) => [o.id, o.outcome]),
  );
  return {
    regressions: known.filter((r) => outcomes.get(r.controlId) === "fail"),
    preExisting: known.filter(
      (r) => outcomes.get(r.controlId) === "pre-existing",
    ),
    added,
  };
}

/** Fail a pull request only when it made one of the gate's controls fail. */
export function exitCodeForPr(comparison: PrComparison): number {
  return comparison.regressions.length > 0 ? 1 : 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 << 20 });
  return stdout;
}

/**
 * The commit the PR is measured against. The default PR checkout is GitHub's
 * merge commit, whose first parent is the base it was merged onto. Any other
 * checkout (the head itself, which may be a merge of main into the branch) is
 * measured against the event's base sha.
 */
export async function prBaseSha(
  workspace: string,
  event: EventPayload | null,
): Promise<string | null> {
  const head = event?.pull_request?.head?.sha;
  try {
    // The raw object still lists both parents in a shallow clone.
    const parents = (await git(workspace, ["cat-file", "-p", "HEAD"]))
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length).trim());
    // Only GitHub's merge commit has the PR's head as its second parent.
    if (parents.length === 2 && parents[0] && head && parents[1] === head) {
      return parents[0];
    }
  } catch {
    // Not a git checkout; only the event can say.
  }
  return event?.pull_request?.base?.sha ?? null;
}

/**
 * Evaluate the controls at `sha` in a throwaway worktree, fetching the commit
 * first when the checkout is shallow. Null when the base can't be read, so the
 * caller falls back to judging the whole repo.
 */
export async function evaluateAtBase(
  workspace: string,
  sha: string,
  controls: Control[],
  options: {
    token?: string | undefined;
    github?: { owner: string; repo: string } | undefined;
  },
): Promise<ControlResult[] | null> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-base-"));
  let added = false;
  try {
    try {
      await git(workspace, ["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      await git(workspace, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
    }
    await git(workspace, ["worktree", "add", "--detach", dir, sha]);
    added = true;
    const ctx = buildContext(dir, options);
    return await evaluateControls(controls, ctx);
  } catch (err) {
    console.error(
      `::warning::rivetari ci: could not evaluate the PR's base ${sha.slice(0, 12)}, so the whole repo is judged: ${(err as Error).message}`,
    );
    return null;
  } finally {
    if (added) {
      await git(workspace, ["worktree", "remove", "--force", dir]).catch(
        (err: unknown) => {
          console.error(
            `::warning::rivetari ci: could not remove the base worktree: ${(err as Error).message}`,
          );
        },
      );
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function idList(results: ControlResult[]): string {
  return results.map((r) => `\`${r.controlId}\``).join(", ");
}

/** The gate summary for a PR measured against its base. */
function prGateLine(
  gate: Gate,
  gateName: string,
  status: GateStatus,
  comparison: PrComparison,
): string {
  const title = gate.title ?? `${gateName} gate`;
  const lines = [
    `**${title}: ${status.toUpperCase()}** — this check fails only on controls this PR made fail.`,
  ];
  if (comparison.regressions.length > 0) {
    lines.push(
      `- Failing because of this PR: ${idList(comparison.regressions)}`,
    );
  }
  if (comparison.preExisting.length > 0) {
    lines.push(`- Already failing at base: ${idList(comparison.preExisting)}`);
  }
  if (comparison.added.length > 0) {
    lines.push(
      `- New controls, not checked at base: ${idList(comparison.added)}`,
    );
  }
  return `\n\n${lines.join("\n")}`;
}

/**
 * `rivetari ci` — the GitHub Action entrypoint, driven by `GITHUB_*` env vars.
 * Audits the checked-out repo, writes the report to the job summary, and either
 * posts a sticky PR comment (failing only on a gate control the PR made fail,
 * measured against its base) or maintains a "Rivetari status" issue on a
 * scheduled run (never failing). See ADR-0006.
 */
export async function runCi(): Promise<number> {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const token = resolveToken(process.env.GITHUB_TOKEN);
  const gateName = process.env.RIVETARI_GATE || "build";
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const now = new Date();

  const { controls, errors } = await loadBundledCatalog();
  if (errors.length > 0) {
    console.error(`::error::Catalog is invalid (${errors.length} error(s)).`);
    for (const err of errors)
      console.error(`::error::${err.file}: ${err.message}`);
    return 1;
  }

  const { gates } = await loadBundledGates();
  const gate = gates.find((g) => g.phase === gateName);
  if (!gate) {
    // Fail closed: a misconfigured gate must not let a PR pass unaudited.
    console.error(
      `::error::rivetari ci: unknown gate "${gateName}". Defined gates: ${gates
        .map((g) => g.phase)
        .join(", ")}.`,
    );
    return 1;
  }

  const ctx = buildContext(workspace, {
    token,
    github: owner && repo ? { owner, repo } : undefined,
  });

  let profile;
  let waivers;
  let evidence;
  try {
    profile = await ctx.profile();
    waivers = await ctx.waivers();
    evidence = await ctx.evidence();
  } catch (err) {
    if (
      err instanceof ProfileError ||
      err instanceof WaiverError ||
      err instanceof EvidenceError
    ) {
      console.error(`::error::rivetari ci: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const all = await evaluateControls(controls, ctx, { profile, waivers });
  // `severity-floor` trims what the report shows; the gate is always judged on
  // every control, so a profile edit can't turn CI green.
  const floorRank = SEVERITIES.indexOf(profile?.["severity-floor"] ?? "low");
  const results = all.filter(
    (r) => SEVERITIES.indexOf(r.severity) <= floorRank,
  );

  // Annotations into the workflow log.
  process.stdout.write(`${renderReport(results, { format: "github" })}\n`);

  // Append a per-lane pass snapshot for the hygiene trend (best-effort), with
  // the status counts the desktop's Posture trend draws.
  await appendHistory(workspace, {
    date: today(now),
    byLane: laneCounts(all),
    summary: summarizeResults(all),
  }).catch(() => undefined);

  const gateResult = evaluateGate(gate, all);

  const event = await readEvent();
  const prNumber = event?.pull_request?.number ?? event?.number ?? null;
  const isPr = prNumber !== null;

  // On a PR, the gate's controls are measured at base too, so a repo whose
  // posture is already red can still merge changes that don't make it worse.
  let comparison: PrComparison | null = null;
  if (isPr) {
    const sha = await prBaseSha(workspace, event);
    const baseAll = sha
      ? await evaluateAtBase(workspace, sha, controls, {
          token,
          github: owner && repo ? { owner, repo } : undefined,
        })
      : null;
    if (baseAll) {
      comparison = comparePr(selectForGate(gate, baseAll), gateResult.controls);
    } else if (!sha) {
      console.error(
        "::warning::rivetari ci: the PR's base commit is unknown, so the whole repo is judged.",
      );
    }
  }

  // Name the gate's blockers explicitly: one may sit below the severity floor and
  // so be missing from the report table above.
  const blocking = gateResult.controls
    .filter((c) => c.status === "fail")
    .map((c) => `\`${c.controlId}\``);
  const gateLine = comparison
    ? prGateLine(gate, gateName, gateResult.status, comparison)
    : `\n\n**${gateResult.title ?? `${gateName} gate`}: ${gateResult.status.toUpperCase()}**` +
      (blocking.length > 0 ? ` — failing: ${blocking.join(", ")}` : "");
  const prExit = comparison
    ? exitCodeForPr(comparison)
    : exitCodeForCi(isPr, gateResult.status);

  const expiring = [
    ...waiversExpiringWithin(waivers, 30, now).map(
      (w) => `waiver \`${w.control}\``,
    ),
    ...evidenceExpiringWithin(evidence, 30, now).map(
      (e) => `evidence \`${e.control}\``,
    ),
  ];
  const expiryLine =
    expiring.length > 0
      ? `\n\n⚠ Expiring within 30 days: ${expiring.join(", ")}`
      : "";

  const body = `${renderReport(results, { format: "markdown" })}${gateLine}${expiryLine}`;

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`, {
      flag: "a",
    });
  }

  if (!owner || !repo || !token) {
    console.error(
      "::warning::rivetari ci: GITHUB_REPOSITORY and a token are required to comment or open issues.",
    );
    return isPr ? prExit : 0;
  }
  const octokit = new Octokit({ auth: token, log: QUIET_LOG });

  if (isPr) {
    try {
      await upsertStickyComment(octokit, owner, repo, prNumber, body);
    } catch (err) {
      console.error(
        `::warning::rivetari ci: could not post PR comment: ${(err as Error).message}`,
      );
    }
    return prExit;
  }

  // schedule / push / dispatch: the status issue is the signal; never fail.
  try {
    await upsertStatusIssue(
      octokit,
      owner,
      repo,
      `${body}${await ciBudgetSection(ctx, profile?.ci?.budget_minutes_per_month, now)}`,
      gateResult.status === "green",
    );
  } catch (err) {
    console.error(
      `::warning::rivetari ci: could not update status issue: ${(err as Error).message}`,
    );
  }
  return 0;
}
