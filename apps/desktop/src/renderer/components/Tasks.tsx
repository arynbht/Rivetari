import { CircleAlert, GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";

import type { TaskNeedsYou, TasksState, TaskSummary } from "../../shared/ipc";

// Read-only on purpose: the tab shows where each task stands and what it waits
// on, and the person acts with the `rivetari task` commands. No control here runs,
// approves, answers or closes anything.

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

const cost = (task: TaskSummary) => `$${task.costUsd.toFixed(2)}`;
const beat = (task: TaskSummary) => (task.done ? "closed" : task.beat);

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
}: {
  tasks: TaskSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
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

function TaskDetail({ task }: { task: TaskSummary }) {
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
        <p className="text-sm">
          <span className="text-muted-foreground">Next: </span>
          {task.next}
        </p>
        {task.pr && (
          <p className="flex items-center gap-1.5 text-sm">
            <GitPullRequest className="h-4 w-4 text-sky-400" aria-hidden />
            <a
              href={task.pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline"
            >
              PR #{task.pr.number}
            </a>
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
      </Card>

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Ledger</h4>
        <ol
          aria-label={`${task.id} ledger`}
          aria-live="polite"
          className="space-y-1.5"
        >
          {task.entries.map((e) => (
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

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Tasks</h2>
        <p className="text-xs text-muted-foreground">
          What each task is doing and what it waits on, as{" "}
          <code>rivetari task status</code> shows it. Act on a task with the{" "}
          <code>rivetari task</code> commands.
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
          <TaskTable tasks={tasks} selected={selected} onSelect={setSelected} />
          {current && <TaskDetail task={current} />}
        </>
      )}
    </div>
  );
}
