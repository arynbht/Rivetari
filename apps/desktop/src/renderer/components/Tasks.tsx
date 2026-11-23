import { CircleAlert, GitPullRequest } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";

import type {
  TaskAnswerResult,
  TaskEntry,
  TaskNeedsYou,
  TaskProgress,
  TasksState,
  TaskSummary,
} from "../../shared/ipc";

// The tab shows where each task stands and what it waits on. Two things can be
// done from it, both by the main process through the runtime: answer a stop
// (allow or deny, with a note) and open the task's PR. Running, approving and
// closing stay with the `rivetari task` commands. What an action changes shows
// up here from the watcher, not from the action's reply.

const NEEDS_LABEL: Record<TaskNeedsYou["kind"], string> = {
  record: "Record fails verification",
  stop: "Stop-and-ask",
  judge: "Judge escalated",
  intake: "Card to confirm",
  route: "Route to approve",
};

/** The ledger's own time format (ledger.md uses it too). */
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

function leaseText(task: TaskSummary): string {
  if (!task.lease) return "—";
  return Date.parse(task.lease.expires) > Date.now()
    ? task.lease.holder
    : `— (${task.lease.holder}'s lease ended)`;
}

/** The ledger is the repo's text: only an https link is made clickable. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A stop the person can answer: the build's question, or the judge's. */
const answerable = (task: TaskSummary) =>
  task.needsYou?.kind === "stop" || task.needsYou?.kind === "judge";

const cost = (task: TaskSummary) => `$${task.costUsd.toFixed(2)}`;
const beat = (task: TaskSummary) => (task.done ? "closed" : task.beat);

/** A running beat this long without an event, a step or a ledger entry looks stuck. */
const QUIET_MS = 5 * 60_000;

/** "40 s" under a minute, "12 min" after. */
const span = (ms: number) =>
  ms < 60_000
    ? `${Math.max(0, Math.floor(ms / 1000))} s`
    : `${Math.floor(ms / 60_000)} min`;

/** The clock, ticking each second while something is running, so the times stay live. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * "Running: build · 12 min · turn 18 · last activity 20 s ago", or, once the
 * beat has been quiet for five minutes, the same with "No activity for N min"
 * in amber. Not a live region: it changes every second.
 */
function RunningLine({
  progress,
  now,
}: {
  progress: TaskProgress;
  now: number;
}) {
  const quiet = now - Date.parse(progress.lastActivityAt);
  const parts = [
    progress.beat,
    span(now - Date.parse(progress.startedAt)),
    ...(progress.turns === undefined ? [] : [`turn ${progress.turns}`]),
  ];
  return quiet >= QUIET_MS ? (
    <span className="text-amber-400">
      Running: {parts.join(" · ")} · No activity for{" "}
      {Math.floor(quiet / 60_000)} min
    </span>
  ) : (
    <span className="text-sky-400">
      Running: {parts.join(" · ")} · last activity {span(quiet)} ago
    </span>
  );
}

function NeedsYou({
  tasks,
  onSelect,
}: {
  tasks: TaskSummary[];
  onSelect: (id: string) => void;
}) {
  const waiting = tasks.filter((t) => t.needsYou);
  return (
    <section aria-labelledby="tasks-needs-you" className="space-y-2">
      <h3 id="tasks-needs-you" className="text-sm font-semibold">
        Needs you
      </h3>
      {waiting.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No task is waiting on a person.
        </p>
      ) : (
        <Card className="border-amber-500/40">
          <ul>
            {waiting.map((t, i) => (
              <li
                key={t.id}
                className={i > 0 ? "border-t border-border/60" : undefined}
              >
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CircleAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {t.id}
                      </span>
                      <span className="truncate text-sm font-medium">
                        {t.title}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t.needsYou?.why}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-amber-400">
                    {t.needsYou ? NEEDS_LABEL[t.needsYou.kind] : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function TaskTable({
  tasks,
  selected,
  onSelect,
  now,
}: {
  tasks: TaskSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <section aria-labelledby="tasks-all" className="space-y-2">
      <h3 id="tasks-all" className="text-sm font-semibold">
        All tasks
      </h3>
      <Card className="overflow-x-auto">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-[44%] px-4 py-2 font-medium">
                Task
              </th>
              <th scope="col" className="w-[10%] px-2 py-2 font-medium">
                Beat
              </th>
              <th scope="col" className="w-[22%] px-2 py-2 font-medium">
                Lease
              </th>
              <th scope="col" className="w-[15%] px-2 py-2 font-medium">
                Rounds
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr
                key={t.id}
                aria-current={t.id === selected ? "true" : undefined}
                className={`border-t border-border/60 ${
                  t.id === selected ? "bg-accent/60" : "hover:bg-accent/30"
                }`}
              >
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className="flex w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {t.id}
                    </span>
                    <span className="truncate">{t.title}</span>
                  </button>
                  {t.progress && (
                    <p className="mt-0.5 truncate text-xs">
                      <RunningLine progress={t.progress} now={now} />
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs">
                  {beat(t)}
                </td>
                <td
                  className="truncate px-2 py-2 text-xs text-muted-foreground"
                  title={leaseText(t)}
                >
                  {leaseText(t)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground">
                  build {t.buildRounds} · judge {t.judgeRounds}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-xs tabular-nums">
                  {cost(t)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

type Outcome =
  | { kind: "answered"; result: TaskAnswerResult }
  | { kind: "opened"; url: string }
  | { kind: "error"; message: string };

function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  if (outcome.kind === "error")
    return (
      <p className="text-xs text-rose-300" role="alert">
        {outcome.message}
      </p>
    );
  if (outcome.kind === "opened")
    return (
      <p className="text-xs" role="status">
        Opened {outcome.url} in your browser.
      </p>
    );
  const { result } = outcome;
  return (
    <div className="space-y-1 text-xs" role="status">
      <p>
        {result.id} {result.answer} by {result.by}. Next: {result.next}
      </p>
      {result.warning && <p className="text-amber-400">{result.warning}</p>}
    </div>
  );
}

function AnswerForm({
  task,
  busy,
  onAnswer,
}: {
  task: TaskSummary;
  busy: boolean;
  onAnswer: (allow: boolean, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const headingId = useId();
  return (
    <form
      aria-labelledby={headingId}
      className="space-y-2 border-t border-border/60 pt-3"
      onSubmit={(e) => e.preventDefault()}
    >
      <h4 id={headingId} className="text-xs font-semibold text-amber-400">
        Answer the stop
      </h4>
      <p className="text-xs">{task.needsYou?.why}</p>
      <label htmlFor={noteId} className="block text-xs text-muted-foreground">
        Note (recorded with the answer; a denied build round is told it)
      </label>
      <textarea
        id={noteId}
        rows={2}
        className={inputClass}
        value={note}
        maxLength={2000}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onAnswer(true, note)}
        >
          Allow
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAnswer(false, note)}
        >
          Deny
        </Button>
        {busy && (
          <span className="self-center text-xs text-muted-foreground">
            Recording…
          </span>
        )}
      </div>
    </form>
  );
}

function TaskDetail({
  task,
  repoPath,
  now,
}: {
  task: TaskSummary;
  repoPath: string;
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The list carries no ledgers; the open task's is fetched, and again each
  // time its last entry moves.
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.rivetari.tasks.ledger(repoPath, task.id).then(
      (next) => {
        if (!live) return;
        setEntries(next);
        setLedgerError(null);
      },
      (err: unknown) => live && setLedgerError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, task.id, task.ledgerSeq]);
  // State lands after the click, so a second click in the same tick would get
  // past `busy`; the ref closes that gap.
  const inFlight = useRef(false);

  const act = (run: () => Promise<Outcome>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    void run()
      .catch((err: unknown): Outcome => ({
        kind: "error",
        message: errorMessage(err),
      }))
      .then((next) => {
        inFlight.current = false;
        setBusy(false);
        setOutcome(next);
      });
  };

  const answer = (allow: boolean, note: string) =>
    act(async () => ({
      kind: "answered",
      result: await window.rivetari.tasks.answer(
        repoPath,
        task.id,
        allow,
        note,
      ),
    }));

  const openPr = () =>
    act(async () => ({
      kind: "opened",
      url: (await window.rivetari.tasks.openPr(repoPath, task.id)).url,
    }));

  return (
    <section aria-labelledby="task-detail" className="space-y-3">
      <Card className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 id="task-detail" className="text-sm font-semibold">
            <span className="font-mono text-muted-foreground">{task.id}</span>{" "}
            {task.title}
          </h3>
          <p className="text-xs text-muted-foreground">
            {task.type} · {task.risk} risk · {task.owner} · {beat(task)} ·{" "}
            {task.tokens.toLocaleString()} tokens · {cost(task)} · from the{" "}
            {task.source === "branch" ? "tasks branch" : "copy on this machine"}
          </p>
        </div>
        {task.progress ? (
          <div className="space-y-0.5 text-sm">
            <p>
              <RunningLine progress={task.progress} now={now} />
            </p>
            {(task.progress.lastTool !== undefined ||
              task.progress.tokens !== undefined) && (
              <p className="text-xs text-muted-foreground">
                {[
                  task.progress.lastTool &&
                    `last tool ${task.progress.lastTool}`,
                  task.progress.tokens !== undefined &&
                    `${task.progress.tokens.toLocaleString()} tokens this call`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm">
            <span className="text-muted-foreground">Next: </span>
            {task.next}
          </p>
        )}
        {task.pr && (
          <p className="flex items-center gap-1.5 text-sm">
            <GitPullRequest className="h-4 w-4 text-sky-400" aria-hidden />
            {isHttps(task.pr.url) ? (
              <a
                href={task.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 underline"
                aria-disabled={busy || undefined}
                onClick={(e) => {
                  // The main process opens the URL the ledger records.
                  e.preventDefault();
                  openPr();
                }}
              >
                PR #{task.pr.number}
              </a>
            ) : (
              <span>
                PR #{task.pr.number} ({task.pr.url})
              </span>
            )}
          </p>
        )}
        {task.problems.length > 0 && (
          <ul
            className="list-inside list-disc text-xs text-rose-300"
            aria-label="Record problems"
          >
            {task.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {answerable(task) && (
          <AnswerForm task={task} busy={busy} onAnswer={answer} />
        )}
        <OutcomeLine outcome={outcome} />
      </Card>

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Ledger</h4>
        {ledgerError && (
          <p className="text-xs text-rose-300" role="alert">
            {ledgerError}
          </p>
        )}
        <ol
          aria-label={`${task.id} ledger`}
          aria-live="polite"
          className="space-y-1.5"
        >
          {entries.map((e) => (
            <li key={e.seq} className="flex gap-3 text-xs">
              <span className="w-28 shrink-0 tabular-nums text-muted-foreground">
                {when(e.at)}
              </span>
              <span className="w-14 shrink-0 text-muted-foreground">
                {e.beat}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {e.section !== "timeline" && (
                  <span className="mr-1 text-amber-400">[{e.section}]</span>
                )}
                {e.text}
                <span className="ml-1 text-muted-foreground">({e.by})</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Tasks({ repoPath }: { repoPath: string }) {
  const [state, setState] = useState<TasksState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.rivetari.tasks.onUpdate((next) => {
      if (active && next.repoPath === repoPath) setState(next);
    });
    window.rivetari.tasks.watch(repoPath).then(
      (first) => active && setState(first),
      (err: unknown) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
      unsubscribe();
      void window.rivetari.tasks.unwatch();
    };
  }, [repoPath]);

  const tasks = state?.tasks ?? [];
  const current = tasks.find((t) => t.id === selected) ?? null;
  const now = useNow(tasks.some((t) => t.progress));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Tasks</h2>
        <p className="text-xs text-muted-foreground">
          What each task is doing and what it waits on, as{" "}
          <code>rivetari task status</code> shows it. Pick a task to answer its
          stop or open its PR; anything else is a <code>rivetari task</code>{" "}
          command.
        </p>
      </div>

      {(error ?? state?.error) && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {error ?? state?.error}
        </p>
      )}

      {state === null && !error ? (
        <p className="text-sm text-muted-foreground">Reading tasks…</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks in this repository yet. Start one with <code>/rivetari</code>{" "}
          in Claude Code or <code>rivetari task new</code>.
        </p>
      ) : (
        <>
          <NeedsYou tasks={tasks} onSelect={setSelected} />
          <TaskTable
            tasks={tasks}
            selected={selected}
            onSelect={setSelected}
            now={now}
          />
          {current && (
            // key keeps one task's answer and outcome off another's detail.
            <TaskDetail
              key={current.id}
              task={current}
              repoPath={repoPath}
              now={now}
            />
          )}
        </>
      )}
    </div>
  );
}
