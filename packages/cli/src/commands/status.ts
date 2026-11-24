import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadBundledCatalog,
  loadBundledGates,
} from "@arynbht/rivetari-catalog";
import {
  buildContext,
  evaluateControls,
  EvidenceError,
  type GateStatus,
  inferPhase,
  ProfileError,
  resolveToken,
  WaiverError,
} from "@arynbht/rivetari-engine";

import { renderStatus, type StatusReport } from "../report.js";

export interface StatusFlags {
  json?: boolean;
  token?: string;
  color?: boolean;
}

export interface RunStatusOptions {
  now?: Date | undefined;
  token?: string | null | undefined;
}

/**
 * `rivetari status` — infer the project phase (the lowest phase whose gate is not
 * green) and list what blocks progress, in severity then effort order.
 */
export async function runStatus(
  path: string,
  flags: StatusFlags,
  options: RunStatusOptions = {},
): Promise<number> {
  const root = resolve(path);
  try {
    if (!(await stat(root)).isDirectory()) {
      console.error(`rivetari status: not a directory: ${path}`);
      return 1;
    }
  } catch {
    console.error(`rivetari status: path not found: ${path}`);
    return 1;
  }

  const { controls, errors } = await loadBundledCatalog();
  if (errors.length > 0) {
    console.error(`Catalog is invalid (${errors.length} error(s)):`);
    for (const err of errors) console.error(`  ${err.file}: ${err.message}`);
    return 1;
  }
  const { gates } = await loadBundledGates();

  const token =
    options.token === null
      ? undefined
      : (options.token ?? resolveToken(flags.token));
  const ctx = buildContext(root, { token, now: options.now });

  let profile;
  let waivers;
  try {
    profile = await ctx.profile();
    waivers = await ctx.waivers();
  } catch (err) {
    if (
      err instanceof ProfileError ||
      err instanceof WaiverError ||
      err instanceof EvidenceError
    ) {
      console.error(`rivetari status: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Every control counts toward the gates: `severity-floor` trims what reports
  // show, it never lowers the bar a phase is judged against.
  const results = await evaluateControls(controls, ctx, {
    now: options.now,
    profile,
    waivers,
  });

  // The phase, the gates and what blocks them come from the engine, which the
  // desktop's Posture view asks too, so the two can't disagree.
  const inference = inferPhase(gates, results, profile?.phase);
  const report: StatusReport = {
    inferredPhase: inference.inferredPhase,
    allGreen: inference.allGreen,
    declaredPhase: profile?.phase ?? null,
    gates: inference.phases.filter(
      (p): p is typeof p & { status: GateStatus } => p.status !== null,
    ),
    blockers: inference.blockers,
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const color = flags.color !== false && process.stdout.isTTY === true;
  process.stdout.write(`${renderStatus(report, color)}\n`);
  return 0;
}
