import type { Autonomy } from "@arynbht/rivetari-catalog";
import picomatch from "picomatch";
import { parse } from "yaml";

import type { Stop } from "../agent/stops.js";
import { type Assembly, AssemblySchema } from "../router/route.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import type { Card } from "./card.js";
import { ladder } from "./ladder.js";
import { confirmTask, loadTask, type Task } from "./tasks.js";

export type { Autonomy };

export async function repoAutonomy(repoPath: string): Promise<Autonomy> {
  return (await ladder(repoPath)).effective;
}

export async function autonomyFor(
  repoPath: string,
  card: Card,
): Promise<Autonomy> {
  return card.risk === "high" ? "supervised" : repoAutonomy(repoPath);
}

export function isSoftStop(stop: Stop): boolean {
  if (stop.trigger === "new_dependency") return stop.osi === true;
  if (stop.trigger === "schema_change") return true;
  return stop.trigger === "protected_path" && stop.reason === "existing-test";
}

export const SENSITIVE_PATHS = [
  "**/auth/**",
  "**/billing/**",
  "**/payments/**",
  "**/migrations/**",
  "**/migrate/**",
  "**/*.sql",
  "**/schema.prisma",
  "**/infra/**",
  "**/terraform/**",
  "**/*.tf",
] as const;

export function routeConcerns(
  card: Card,
  assembly: Assembly,
  borderline: readonly string[],
): string[] {
  const concerns: string[] = [];
  if (borderline.length > 0)
    concerns.push(`borderline sector(s): ${borderline.join(", ")}`);
  const sensitive = picomatch(
    [
      ...SENSITIVE_PATHS,
      ...assembly.stop_and_ask.flatMap((s) =>
        typeof s === "string" ? [] : s.touches,
      ),
    ],
    { dot: true },
  );
  const hit = card.touches.filter((t) => sensitive(t));
  if (hit.length > 0)
    concerns.push(`touches sensitive paths: ${hit.join(", ")}`);
  return concerns;
}

const BORDERLINE = /^under the threshold, for the approver: (.+)$/;
const DECIDED_OUT = /^decided not in: (\S+) \(/;

function borderlineOf(task: Task): string[] {
  const entries = [...task.entries].reverse();
  const at = entries.findIndex(
    (e) => e.beat === "route" && BORDERLINE.test(e.text),
  );
  if (at === -1) return [];
  const decided = new Set(
    entries
      .slice(0, at)
      .filter((e) => e.beat === "route")
      .map((e) => DECIDED_OUT.exec(e.text)?.[1])
      .filter((s): s is string => s !== undefined),
  );
  return (
    entries[at]?.text
      .match(BORDERLINE)?.[1]
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s && !decided.has(s)) ?? []
  );
}

export interface Advance {
  task: Task;
  level: Autonomy;
  did: string[];
  waiting?: string | undefined;
}

export async function advanceTask(
  repoPath: string,
  id: string,
  options: {
    by: string;
    now?: Date | undefined;
    context?: RouteContext | undefined;
  },
): Promise<Advance> {
  let task = await loadTask(repoPath, id);
  const level = await autonomyFor(repoPath, task.card);
  const did: string[] = [];
  if (level === "supervised" || task.problems.length > 0)
    return { task, level, did };
  const by = `rivetari runtime (autonomy ${level}, for ${options.by})`;
  if (!task.confirmed) {
    task = await confirmTask(repoPath, id, { by, now: options.now });
    did.push(`card confirmed without asking (autonomy ${level})`);
  }
  if (!task.approved) {
    let borderline: string[];
    if (task.assemblyText === undefined) {
      const routed = await routeTask(repoPath, id, {
        by: options.by,
        now: options.now,
        context: options.context,
      });
      task = routed.task;
      const { decidedOut } = routed.routing;
      borderline = routed.routing.borderline.filter(
        (s) => !decidedOut.includes(s),
      );
    } else borderline = borderlineOf(task);
    const assembly = AssemblySchema.parse(parse(task.assemblyText ?? ""));
    const concerns = routeConcerns(task.card, assembly, borderline);
    if (concerns.length > 0)
      return {
        task,
        level,
        did,
        waiting: `route: a person approves this route (${concerns.join("; ")}): review assembly.yml, then \`rivetari task approve ${id}\``,
      };
    task = (
      await approveRoute(repoPath, id, {
        by,
        now: options.now,
        context: options.context,
      })
    ).task;
    did.push(`route approved without asking (autonomy ${level})`);
  }
  return { task, level, did };
}
