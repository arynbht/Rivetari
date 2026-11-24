import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { confirm, isCancel } from "@clack/prompts";
import { AiError } from "@arynbht/rivetari-engine";
import { RegistryError } from "@arynbht/rivetari-registry";
import {
  advanceTask,
  answerStops,
  approveRoute,
  autonomyFor,
  buildTask,
  CardError,
  checkTouches,
  closeTask,
  commitTask,
  enforceFallback,
  floorplanOnMerge,
  type CommitOptions,
  holderName,
  isolateTask,
  judgeTask,
  confirmTask,
  LEASE_MS,
  type LedgerEntry,
  LedgerError,
  listTasks,
  loadTask,
  localLease,
  newTask,
  nextStep,
  oneAtATime,
  openStops,
  parallelExitCode,
  parseAcceptanceFlag,
  parseCard,
  profileConflicts,
  proveTask,
  pullTasks,
  reasonSummary,
  repoAutonomy,
  reserveTaskId,
  routeTask,
  runnable,
  runParallel,
  runTask,
  sha256,
  shipTask,
  StoreError,
  type Task,
  TaskError,
  whoami,
} from "@arynbht/rivetari-runtime";
import { parse, stringify } from "yaml";

export interface TaskNewFlags {
  type?: string;
  description?: string;
  accept?: string[];
  outOfScope?: string[];
  touches?: string[];
  page?: string[];
  constraint?: string[];
  risk?: string;
  source?: string;
  from?: string;
  force?: boolean;
  path?: string;
}

let unpushed = false;

async function guarded(action: () => Promise<number>): Promise<number> {
  unpushed = false;
  try {
    const code = await action();
    return unpushed ? 1 : code;
  } catch (err) {
    if (
      err instanceof CardError ||
      err instanceof TaskError ||
      err instanceof LedgerError ||
      err instanceof RegistryError ||
      err instanceof StoreError ||
      // A failed AI call says what went wrong; a stack trace adds nothing.
      err instanceof AiError
    ) {
      console.error(`rivetari task: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * Bring this checkout's task records up to the rivetari/tasks branch, saying
 * which ones it kept because they hold work no push has carried yet. A
 * read-only command carries on with the local copy when the branch can't be
 * reached; a beat can't, since it has to take the task's lease.
 */
async function pull(
  repo: string,
  options: { readOnly?: boolean } = {},
): Promise<void> {
  try {
    const { kept } = await pullTasks(repo);
    for (const id of kept)
      process.stderr.write(
        `rivetari task: kept this machine's record of ${id}: it has work the branch doesn't, which its next beat pushes\n`,
      );
  } catch (err) {
    if (!options.readOnly || !(err instanceof StoreError)) throw err;
    process.stderr.write(
      `rivetari task: ${err.message}; showing this machine's copy\n`,
    );
  }
}

/**
 * Run one beat of task `id` against the tasks branch: pull the record,
 * take or renew this machine's lease (refused, before anything runs, while
 * someone else holds it), run, and push what the beat wrote, even when it
 * failed part-way, so the record never only lives here. A long beat renews
 * its lease as it goes, so it isn't taken over mid-run. `pulled` skips the
 * pull when the caller has just pulled and other tasks are mid-beat, since a
 * pull rewrites their records under them.
 */
async function onTask<T>(
  repo: string,
  id: string,
  beat: string,
  action: (by: string) => Promise<T>,
  finish: (result: T) => Partial<CommitOptions> = () => ({}),
  options: { pulled?: boolean } = {},
): Promise<T> {
  const by = await whoami(repo);
  const holder = holderName(by);
  if (!options.pulled) await pull(repo);
  await commitTask(repo, id, { holder, message: `${id}: ${beat}` });
  // One write at a time: the heartbeat and the final push never overlap.
  let writes: Promise<unknown> = Promise.resolve();
  const heartbeat = setInterval(() => {
    writes = writes
      .then(() =>
        commitTask(repo, id, {
          holder,
          message: `${id}: ${beat} running`,
          leaseOnly: true,
        }),
      )
      .catch(() => undefined);
  }, LEASE_MS / 4);
  heartbeat.unref();
  let result: T;
  try {
    result = await action(by);
  } catch (err) {
    clearInterval(heartbeat);
    await writes;
    // Push what it got through; the beat's own error is the one to report.
    await commitTask(repo, id, {
      holder,
      message: `${id}: ${beat} failed`,
    }).catch(() => undefined);
    throw err;
  }
  clearInterval(heartbeat);
  await writes;
  try {
    await commitTask(repo, id, {
      holder,
      message: `${id}: ${beat} done`,
      ...finish(result),
    });
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    unpushed = true;
    process.stderr.write(
      `rivetari task: ${beat} is done, but pushing its record failed: ${err.message}\nrivetari task: the record is kept on this machine; the next \`rivetari task\` beat on ${id} pushes it once origin is reachable\n`,
    );
  }
  return result;
}

/** Other open tasks, after the pull, so isolate picks a port none of them holds. */
async function openTaskIds(repo: string, id: string): Promise<string[]> {
  // A closed task's port is free again.
  return (await listTasks(repo))
    .filter((t) => t.card.id !== id && nextStep(t) !== "done")
    .map((t) => t.card.id);
}

/** A ledger entry as `task run` reports it. */
const entryLine = (e: LedgerEntry) =>
  `${e.at.slice(11, 16)} ${e.beat}${e.section === "timeline" ? "" : ` (${e.section})`}: ${e.text}`;

function describe(task: Task): string {
  const status =
    task.problems.length > 0
      ? "TAMPERED"
      : nextStep(task) === "done"
        ? "closed"
        : !task.confirmed
          ? "draft"
          : task.beat === "intake"
            ? "confirmed"
            : task.beat;
  return `${task.card.id}  ${status.padEnd(9)} ${task.card.title}`;
}

/** `rivetari task new "<title>"`: draft a card from flags or a YAML file. */
export function runTaskNew(
  title: string | undefined,
  flags: TaskNewFlags,
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const fromFile = flags.from
      ? ((parse(await readFile(resolve(flags.from), "utf8")) ?? {}) as Record<
          string,
          unknown
        >)
      : {};
    const input = {
      ...fromFile,
      ...(title ? { title } : {}),
      ...(flags.type ? { type: flags.type } : {}),
      ...(flags.description ? { description: flags.description } : {}),
      ...(flags.accept?.length
        ? { acceptance: flags.accept.map(parseAcceptanceFlag) }
        : {}),
      ...(flags.outOfScope?.length ? { out_of_scope: flags.outOfScope } : {}),
      ...(flags.touches?.length ? { touches: flags.touches } : {}),
      ...(flags.page?.length ? { pages: flags.page } : {}),
      ...(flags.constraint?.length ? { constraints: flags.constraint } : {}),
      ...(flags.risk ? { risk: flags.risk } : {}),
      ...(flags.source ? { source: flags.source } : {}),
    } as Parameters<typeof newTask>[1];
    const by = await whoami(repo);
    // Refuse a bad card before an id is reserved for it on the branch.
    const card = parseCard({
      ...input,
      id: "T-0000",
      owner: by,
      created: "2000-01-01",
    });
    await checkTouches(repo, card.touches);
    // A criterion the profile rules out would cost a build round at the judge.
    const conflicts = await profileConflicts(repo, card);
    if (conflicts.refuse.length > 0 && !flags.force)
      throw new CardError([
        ...conflicts.refuse,
        "(--force drafts it anyway, and the ledger says so)",
      ]);
    const holder = holderName(by);
    const id = await reserveTaskId(repo, { holder });
    const task = await newTask(repo, input, { by, id, force: flags.force });
    await commitTask(repo, id, { holder, message: `${id}: drafted` });
    for (const c of [...conflicts.refuse, ...conflicts.warn])
      process.stderr.write(`rivetari task new: heads-up: ${c}\n`);
    if ((await autonomyFor(repo, task.card)) === "supervised") {
      process.stdout.write(
        `drafted ${task.card.id}: ${task.card.title}\n` +
          `review .rivetari/tasks/${task.card.id}/card.yml, then \`rivetari task confirm ${task.card.id}\`\n`,
      );
      return 0;
    }
    const advance = await onTask(repo, id, "intake", (who) =>
      advanceTask(repo, id, { by: who }),
    );
    process.stdout.write(
      `drafted ${task.card.id}: ${task.card.title}\n${advance.did.map((d) => `${d}\n`).join("")}next: ${advance.waiting ?? `\`rivetari task run ${id}\``}\n`,
    );
    return 0;
  });
}

/**
 * `rivetari task confirm <id>`: a person agrees the card. Shows it and asks at
 * the terminal; without one, `--yes` is required — and recorded as such.
 */
export function runTaskConfirm(
  id: string,
  flags: { yes?: boolean; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    await pull(repo);
    const task = await loadTask(repo, id);
    process.stdout.write(`${stringify(task.card)}\n`);
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        console.error(
          "rivetari task confirm: confirming a card needs a person at the terminal (or --yes).",
        );
        return 1;
      }
      const ok = await confirm({
        message: `Confirm ${id} as the agreed card?`,
      });
      if (isCancel(ok) || !ok) {
        process.stdout.write("not confirmed\n");
        return 1;
      }
    }
    await onTask(repo, id, "confirm", (by) =>
      confirmTask(repo, id, { by: flags.yes ? `${by} (--yes)` : by }),
    );
    process.stdout.write(`${id} confirmed; next: route\n`);
    return 0;
  });
}

/** `rivetari task status`: every task, its beat, and whether its record is intact. */
export function runTaskStatus(flags: { path?: string }): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    await pull(repo, { readOnly: true });
    const tasks = await listTasks(repo);
    if (tasks.length === 0) {
      process.stdout.write('no tasks yet: `rivetari task new "<title>"`\n');
      return 0;
    }
    for (const task of tasks) {
      process.stdout.write(`${describe(task)}\n`);
      // In full, so a question can be read and answered from here.
      if (task.problems.length === 0)
        for (const stop of openStops(task))
          process.stdout.write(`  waiting on: ${stop}\n`);
    }
    return tasks.some((t) => t.problems.length > 0) ? 1 : 0;
  });
}

/**
 * `rivetari task resume <id>`: verify the record, show the ledger, and say what
 * comes next — the point a restarted session picks up from.
 */
export function runTaskResume(
  id: string,
  flags: { path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const holder = holderName(await whoami(repo));
    await pull(repo, { readOnly: true });
    const task = await loadTask(repo, id);
    const lease = await localLease(repo, id);
    const held =
      lease && Date.parse(lease.expires) > Date.now() ? lease : undefined;
    if (task.problems.length > 0) {
      console.error(`rivetari task: ${id} fails verification; not resuming:`);
      for (const p of task.problems) console.error(`  - ${p}`);
      if (held && held.holder !== holder)
        console.error(
          `  (${id} was recorded by ${held.holder}. A ledger signed on another machine only verifies with the same key: set RIVETARI_LEDGER_KEY to the team's key.)`,
        );
      return 1;
    }
    process.stdout.write(await readFile(task.ledger.mdPath, "utf8"));
    if (held)
      process.stdout.write(
        `\nheld by ${held.holder} until ${held.expires}${held.holder === holder ? " (this machine)" : `; it can be taken over after that, or once they run \`rivetari task release ${id}\``}\n`,
      );
    process.stdout.write(`\nnext: ${nextStep(task)}\n`);
    return 0;
  });
}

/**
 * `rivetari task release <id>`: give up this machine's lease, so someone else
 * can take the task over now instead of when the lease runs out.
 */
export function runTaskRelease(
  id: string,
  flags: { path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const holder = holderName(await whoami(repo));
    await pull(repo);
    await commitTask(repo, id, {
      holder,
      message: `${id}: released`,
      release: true,
    });
    process.stdout.write(
      `${id} released: the next person to run one of its beats takes it over\n`,
    );
    return 0;
  });
}

/**
 * `rivetari task route <id>`: route the confirmed card and show the proposed
 * assembly with the reasons behind it; nothing is approved yet.
 */
export function runTaskRoute(
  id: string,
  flags: { path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { routing } = await onTask(repo, id, "route", (by) =>
      routeTask(repo, id, { by }),
    );
    const out: string[] = ["sectors:"];
    for (const s of routing.scores) {
      const mark = routing.assembly.sectors.includes(s.sector) ? "in" : "  ";
      out.push(`  ${mark} ${s.sector} ${s.score}: ${reasonSummary(s.reasons)}`);
    }
    if (routing.borderline.length > 0)
      out.push(
        `under the threshold (add them to the assembly if they belong): ${routing.borderline.join(", ")}`,
      );
    for (const note of routing.notes) out.push(`note: ${note}`);
    out.push("", stringify(routing.assembly).trimEnd(), "");
    out.push(
      `wrote .rivetari/tasks/${id}/assembly.yml; edit it if you disagree, then \`rivetari task approve ${id}\``,
    );
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  });
}

/**
 * `rivetari task approve <id>`: a person agrees the assembly — the last
 * approval before the agent starts. As with confirm, `--yes` without a
 * terminal, recorded as such.
 */
export function runTaskApprove(
  id: string,
  flags: { yes?: boolean; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    await pull(repo);
    const task = await loadTask(repo, id);
    // Say what's wrong before asking anyone to approve anything.
    if (task.approved) {
      console.error(`rivetari task: ${id}'s route is already approved`);
      return 1;
    }
    if (task.assemblyText === undefined) {
      console.error(
        `rivetari task: ${id} hasn't been routed: \`rivetari task route ${id}\``,
      );
      return 1;
    }
    const shown = sha256(task.assemblyText);
    process.stdout.write(`${task.assemblyText}\n`);
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        console.error(
          "rivetari task approve: approving an assembly needs a person at the terminal (or --yes).",
        );
        return 1;
      }
      const ok = await confirm({
        message: `Approve this assembly for ${id}?`,
      });
      if (isCancel(ok) || !ok) {
        process.stdout.write("not approved\n");
        return 1;
      }
    }
    await onTask(repo, id, "approve", (by) =>
      approveRoute(repo, id, { by: flags.yes ? `${by} (--yes)` : by, shown }),
    );
    process.stdout.write(`${id} route approved; next: isolate\n`);
    return 0;
  });
}

/** `rivetari task isolate <id>`: the task's worktree, branch, port and database. */
export function runTaskIsolate(
  id: string,
  flags: { base?: string; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { isolation } = await onTask(repo, id, "isolate", async (by) =>
      isolateTask(repo, id, {
        by,
        base: flags.base,
        otherTasks: await openTaskIds(repo, id),
      }),
    );
    process.stdout.write(
      `${id}: worktree ${isolation.worktree} on ${isolation.branch} from ${isolation.baseRef} · port ${isolation.port} · db ${isolation.database}\nnext: \`rivetari task build ${id}\`\n`,
    );
    return 0;
  });
}

/**
 * `rivetari task build <id>`: plan, then build in the worktree; pauses on
 * anything the operating rules say to ask about.
 */
export function runTaskBuild(
  id: string,
  flags: { model?: string; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const outcome = await onTask(repo, id, "build", (by) =>
      buildTask(repo, id, { by, model: flags.model }),
    );
    for (const s of outcome.stops)
      process.stdout.write(`stop: ${s.trigger}: ${s.detail}\n`);
    process.stdout.write(`next: ${nextStep(outcome.task)}\n`);
    return outcome.stops.length > 0 ? 2 : 0;
  });
}

/** `rivetari task answer <id> --allow|--deny [note]`: answer the open stops. */
export function runTaskAnswer(
  id: string,
  note: string | undefined,
  flags: { allow?: boolean; deny?: boolean; path?: string },
): Promise<number> {
  return guarded(async () => {
    if (Boolean(flags.allow) === Boolean(flags.deny)) {
      console.error("rivetari task answer: give one of --allow or --deny.");
      return 1;
    }
    const repo = resolve(flags.path ?? ".");
    const task = await onTask(repo, id, "answer", (by) =>
      answerStops(repo, id, { allow: Boolean(flags.allow), note, by }),
    );
    process.stdout.write(`next: ${nextStep(task)}\n`);
    return 0;
  });
}

/** `rivetari task prove <id>`: run the assembly's proof and record it. */
export function runTaskProve(
  id: string,
  flags: { path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { task, record } = await onTask(repo, id, "prove", (by) =>
      proveTask(repo, id, { by }),
    );
    for (const line of record.lines) process.stdout.write(`${line}\n`);
    process.stdout.write(
      `proof ${record.passed ? "passed" : "failed"}; next: ${nextStep(task)}\n`,
    );
    return record.passed ? 0 : 1;
  });
}

/**
 * `rivetari task judge <id>`: tier 1 and tier 2 on the task's branch. Exits 0
 * when it passed, 1 when it went back to build, 2 when it needs a person.
 */
export function runTaskJudge(
  id: string,
  flags: { model?: string; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { task, record } = await onTask(repo, id, "judge", (by) =>
      judgeTask(repo, id, {
        by,
        model: flags.model,
        log: (line) => process.stderr.write(`· ${line}\n`),
      }),
    );
    if (record.review) process.stdout.write(`${record.review.body}\n\n`);
    process.stdout.write(
      `judge ${record.verdict} (round ${record.round}); next: ${nextStep(task)}\n`,
    );
    return record.verdict === "passed"
      ? 0
      : record.verdict === "failed"
        ? 1
        : 2;
  });
}

/** `rivetari task ship <id>`: push the judged branch and open its draft PR. */
export function runTaskShip(
  id: string,
  flags: { path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { task, pr } = await onTask(repo, id, "ship", (by) =>
      shipTask(repo, id, { by }),
    );
    process.stdout.write(
      `${pr.reused ? "updated" : "opened"} draft PR #${pr.number}: ${pr.url}\nnext: ${nextStep(task)}\n`,
    );
    return 0;
  });
}

/** `rivetari task close <id> [--abandon "<why>"] [--force]`: record the outcome and seal the ledger. */
export function runTaskClose(
  id: string,
  flags: { abandon?: string | boolean; force?: boolean; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    const { row, cleanup } = await onTask(
      repo,
      id,
      "close",
      (by) =>
        closeTask(repo, id, {
          by,
          // `--abandon` alone gives no reason; that's allowed.
          abandon:
            typeof flags.abandon === "string"
              ? flags.abandon
              : flags.abandon
                ? ""
                : undefined,
          force: flags.force,
          // "Update the floorplan" when the profile keeps one.
          floorplan: () => floorplanOnMerge(repo),
        }),
      // A closed task's lease is given up, and its row joins the history.
      ({ row }) => ({ release: true, history: [JSON.stringify(row)] }),
    );
    const ladderState = await enforceFallback(repo, {
      by: `rivetari runtime (for ${await whoami(repo)})`,
    });
    if (ladderState.effective !== ladderState.configured)
      process.stdout.write(
        `autonomy fell back to ${ladderState.effective}: ${ladderState.fallback}\n`,
      );
    process.stdout.write(
      `${id} closed: ${row.outcome}${row.pr ? ` (PR #${row.pr})` : ""} · ${row.minutes} min · ${row.tokens} tokens · $${row.cost_usd.toFixed(2)}; ledger sealed\n`,
    );
    // `gh pr merge --delete-branch` can't delete the local branch while the
    // task's worktree holds it, so close is where that happens.
    if (cleanup)
      process.stdout.write(
        `${cleanup}\n(close removes the task's worktree first, then deletes its local branch once the PR is merged; \`gh pr merge --delete-branch\` can't while the worktree holds it, so merge, then close)\n`,
      );
    return 0;
  });
}

/**
 * `rivetari task run <id>`: isolate → build → prove → judge → ship, reporting
 * each ledger entry, until a person is needed. Exits 0 when it shipped, 2 when
 * it waits on a person, 1 on an error.
 */
export function runTaskRun(
  id: string,
  flags: { model?: string; base?: string; path?: string },
): Promise<number> {
  return guarded(async () => {
    const repo = resolve(flags.path ?? ".");
    let outcome: Awaited<ReturnType<typeof runTask>>;
    try {
      outcome = await onTask(repo, id, "run", async (by) =>
        runTask(repo, id, {
          by,
          model: flags.model,
          base: flags.base,
          otherTasks: await openTaskIds(repo, id),
          onEntry: (e) => process.stdout.write(`${entryLine(e)}\n`),
          prove: { deferTestRun: true },
          judge: { log: (line) => process.stderr.write(`· ${line}\n`) },
        }),
      );
    } catch (err) {
      // A run that dies part-way still ends with where the task stands, so
      // whoever (or whatever) started it knows what to run next.
      process.stdout.write(`${await stoppedLine(repo, id, err)}\n`);
      throw err;
    }
    process.stdout.write(`next: ${outcome.next}\n`);
    return outcome.ran.at(-1) === "ship" ? 0 : 2;
  });
}

/** The summary for a run an error stopped: what failed, and the step it left. */
export async function stoppedLine(
  repo: string,
  id: string,
  err: unknown,
): Promise<string> {
  const message = err instanceof Error ? err.message : String(err);
  const next = await loadTask(repo, id)
    .then((t) => nextStep(t))
    .catch(() => "unknown (the task couldn't be read)");
  return `run stopped: ${message.replace(/\s+/g, " ").slice(0, 600)}\nnext: ${next}`;
}

/** `--parallel`'s value, or null (said why) when it isn't a whole number from 1. */
function parallelOf(flags: { parallel?: number }): number | null {
  const n = flags.parallel ?? 1;
  if (Number.isInteger(n) && n >= 1) return n;
  console.error(
    "rivetari task run: --parallel takes a whole number of tasks, 1 or more",
  );
  return null;
}

/**
 * Run `ids` through `runTask`, up to `parallel` at once, each under its own
 * lease and in its own worktree as a single run is. The caller has pulled.
 * Every line starts with the task it's about, and a summary says how each
 * one ended: exits 0 when all shipped, 2 when any waits on a person (and none
 * errored), 1 when any errored.
 */
async function runMany(
  repo: string,
  ids: string[],
  flags: { model?: string; base?: string; parallel: number },
): Promise<number> {
  const tasks = await Promise.all(ids.map((id) => loadTask(repo, id)));
  const touches = new Map(tasks.map((t) => [t.card.id, t.card.touches]));
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const isolating = oneAtATime();
  const results = await runParallel(
    tasks.map((t) => ({ id: t.card.id, touches: t.card.touches })),
    {
      parallel: flags.parallel,
      onStart: (id) => say(`${id} started`),
      onWait: (id, behind) =>
        say(
          `${id} waits for ${behind.join(", ")}: ${
            touches.get(id)?.length
              ? "their touches could name the same file"
              : "its card names no touches, so it could change any file"
          }`,
        ),
      run: (id) =>
        onTask(
          repo,
          id,
          "run",
          async (by) =>
            runTask(repo, id, {
              by,
              model: flags.model,
              base: flags.base,
              otherTasks: await openTaskIds(repo, id),
              isolating,
              onEntry: (e) => say(`${id} ${entryLine(e)}`),
              prove: { deferTestRun: true },
              judge: {
                log: (line) => process.stderr.write(`${id} · ${line}\n`),
              },
            }),
          undefined,
          // No second pull, even for a task that starts late: onTask's first
          // commitTask fetches the branch tip itself and is refused while
          // anyone else holds the lease, before the run starts.
          { pulled: true },
        ),
    },
  );
  const label = { shipped: "shipped", stopped: "needs you", errored: "failed" };
  say("summary:");
  for (const r of results) say(`  ${r.id} ${label[r.status]}: ${r.next}`);
  return parallelExitCode(results);
}

/**
 * `rivetari task run [ids...] --parallel N`: the named tasks, or every
 * confirmed, route-approved task the driver can move on, up to N at once.
 * Tasks whose touches could name the same file run one after the other.
 */
export function runTaskRunParallel(
  ids: string[],
  flags: { model?: string; base?: string; path?: string; parallel?: number },
): Promise<number> {
  return guarded(async () => {
    const parallel = parallelOf(flags);
    if (parallel === null) return 1;
    const repo = resolve(flags.path ?? ".");
    // One pull for the whole run: once tasks are running, a pull would
    // rewrite their records under them.
    await pull(repo);
    const chosen =
      ids.length > 0
        ? [...new Set(ids)]
        : (await listTasks(repo))
            .filter(
              (t) =>
                t.problems.length === 0 &&
                t.confirmed &&
                t.approved &&
                runnable(nextStep(t)) !== null,
            )
            .map((t) => t.card.id);
    if (chosen.length === 0) {
      process.stdout.write(
        "nothing to run: no confirmed, route-approved task is waiting on isolate, build, prove, judge or ship\n",
      );
      return 0;
    }
    return runMany(repo, chosen, { ...flags, parallel });
  });
}

const PARKED = /^(stop-and-ask|close|done)/;

export function runTaskRunAll(flags: {
  model?: string;
  base?: string;
  path?: string;
  parallel?: number;
}): Promise<number> {
  return guarded(async () => {
    const parallel = parallelOf(flags);
    if (parallel === null) return 1;
    const repo = resolve(flags.path ?? ".");
    const level = await repoAutonomy(repo);
    if (level !== "unattended") {
      console.error(
        `rivetari task: run --all needs \`autonomy: unattended\` in .rivetari/profile.yml (this repo is ${level})`,
      );
      return 1;
    }
    await pull(repo);
    const queue = (await listTasks(repo))
      .filter((t) => !PARKED.test(nextStep(t)))
      .map((t) => t.card.id);
    if (parallel > 1 && queue.length > 0)
      return runMany(repo, queue, { ...flags, parallel });
    const shipped: string[] = [];
    const parked: string[] = [];
    let failed = false;
    for (const id of queue) {
      process.stdout.write(`== ${id}\n`);
      try {
        const outcome = await onTask(repo, id, "run", async (by) =>
          runTask(repo, id, {
            by,
            model: flags.model,
            base: flags.base,
            otherTasks: await openTaskIds(repo, id),
            onEntry: (e) => process.stdout.write(`${entryLine(e)}\n`),
            prove: { deferTestRun: true },
            judge: { log: (line) => process.stderr.write(`· ${line}\n`) },
          }),
        );
        if (outcome.ran.at(-1) === "ship") shipped.push(id);
        else parked.push(`${id}: ${outcome.next}`);
      } catch (err) {
        failed = true;
        parked.push(`${id}: ${(err as Error).message}`);
      }
    }
    process.stdout.write(
      `shipped: ${shipped.join(", ") || "none"}\n${parked.length > 0 ? `needs you:\n${parked.map((p) => `- ${p}\n`).join("")}` : ""}`,
    );
    if (failed) return 1;
    return parked.length > 0 ? 2 : 0;
  });
}
