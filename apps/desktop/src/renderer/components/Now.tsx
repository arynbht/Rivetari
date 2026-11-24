import { CircleAlert, GitPullRequest } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { AnswerForm, isHttps, QUIET_MS } from "@/components/Tasks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { span, useNow, when } from "@/lib/time";

import type {
  NeedsYouItem,
  NowCi,
  NowHealth,
  NowJudge,
  NowRunning,
  NowState,
  RecentEvent,
} from "../../shared/ipc";

// The repo as it stands now: what's running, everything that waits on a
// person, what just happened, and the repo's health. All of it is the main
// process's reading of the runtime's records. Three things can be done here,
// each through the runtime the way the CLI does it: confirm a card, approve a
// route, answer a stop. What an action changes shows up from the watcher, not
// from the action's reply. Merging a waiting PR stays on GitHub for now.

const KIND_LABEL: Record<NeedsYouItem["kind"], string> = {
  intake: "Card to confirm",
  route: "Route to approve",
  stop: "Stop-and-ask",
  judge: "Judge wants a person",
  merge: "PR waiting to merge",
  record: "Record fails verification",
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const list = (items: string[]) =>
  items.length > 0 ? items.join(", ") : "none";

type Outcome =
  | { kind: "done"; text: string; warning: string | null }
  | { kind: "error"; message: string };

function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  if (outcome.kind === "error")
    return (
      <p className="text-xs text-rose-300" role="alert">
        {outcome.message}
      </p>
    );
  return (
    <div className="space-y-1 text-xs" role="status">
      <p>{outcome.text}</p>
      {outcome.warning && <p className="text-amber-400">{outcome.warning}</p>}
    </div>
  );
}

/** One action at a time per item; a second click in the same tick is dropped. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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
  return { busy, outcome, act };
}

function PrLink({ repoPath, item }: { repoPath: string; item: NeedsYouItem }) {
  const [error, setError] = useState<string | null>(null);
  if (!item.pr) return null;
  const { number, url } = item.pr;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm">
      <GitPullRequest className="h-4 w-4 text-sky-400" aria-hidden />
      {isHttps(url) ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 underline"
          onClick={(e) => {
            // The main process opens the URL the ledger records.
            e.preventDefault();
            setError(null);
            window.rivetari.now
              .openPr(repoPath, item.id)
              .catch((err: unknown) => setError(errorMessage(err)));
          }}
        >
          PR #{number}
        </a>
      ) : (
        <span>
          PR #{number} ({url})
        </span>
      )}
      {error && (
        <span className="text-xs text-rose-300" role="alert">
          {error}
        </span>
      )}
    </p>
  );
}

function NextLine({ next }: { next: string }) {
  return (
    <p className="text-xs">
      <span className="text-muted-foreground">Next: </span>
      {next}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

function IntakeBody({
  repoPath,
  item,
}: {
  repoPath: string;
  item: Extract<NeedsYouItem, { kind: "intake" }>;
}) {
  const { busy, outcome, act } = useAction();
  const { card } = item;
  return (
    <div className="space-y-3">
      <p className="text-sm">{card.description}</p>
      <div className="space-y-1">
        <h5 className="text-xs font-semibold">Acceptance criteria</h5>
        <ul className="space-y-1 text-xs">
          {card.acceptance.map((a) => (
            <li key={a.id}>
              <span className="font-mono text-muted-foreground">{a.id}</span>{" "}
              {a.text}{" "}
              <span className="text-muted-foreground">
                (verified by {a.verify})
              </span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="space-y-1">
        <Field label="Type and risk">
          {card.type} · {card.risk} risk
        </Field>
        {card.touches.length > 0 && (
          <Field label="Touches">{card.touches.join(", ")}</Field>
        )}
        {card.outOfScope.length > 0 && (
          <Field label="Out of scope">{card.outOfScope.join("; ")}</Field>
        )}
      </dl>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const r = await window.rivetari.now.confirm(
                repoPath,
                item.id,
                item.shown,
              );
              return {
                kind: "done",
                text: `${r.id} confirmed by ${r.by}. Next: ${r.next}`,
                warning: r.warning,
              };
            })
          }
        >
          Confirm
        </Button>
        {busy && (
          <span className="text-xs text-muted-foreground">Recording…</span>
        )}
      </div>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

function RouteBody({
  repoPath,
  item,
}: {
  repoPath: string;
  item: Extract<NeedsYouItem, { kind: "route" }>;
}) {
  const { busy, outcome, act } = useAction();
  const a = item.assembly;
  return (
    <div className="space-y-3">
      {a ? (
        <dl className="space-y-1">
          <Field label="Sectors">{list(a.sectors)}</Field>
          <Field label="Skills">
            {list(a.skills)}
            {a.spine.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                (spine: {a.spine.join(", ")})
              </span>
            )}
          </Field>
          <Field label="Gaps">{list(a.gaps)}</Field>
          <Field label="Checks">{list(a.checks)}</Field>
          <Field label="Proof">{a.proof}</Field>
          <Field label="Budget">
            {a.budget.skillTokens.toLocaleString()} skill tokens ·{" "}
            {a.budget.contextTokens.toLocaleString()} context tokens ·{" "}
            {a.budget.steps} steps
          </Field>
          <Field label="Stop and ask">{list(a.stopAndAsk)}</Field>
          <Field label="Review">
            {a.review.designPass ? "design pass" : "no design pass"} ·{" "}
            {a.review.security ? "security review" : "no security review"}
          </Field>
        </dl>
      ) : (
        <ul
          className="list-inside list-disc text-xs text-rose-300"
          aria-label="Why the assembly can't be read"
        >
          {item.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {item.reasons.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold">Why the router chose it</h5>
          <ul className="list-inside list-disc space-y-0.5 text-xs">
            {item.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !a}
          onClick={() =>
            act(async () => {
              const r = await window.rivetari.now.approve(
                repoPath,
                item.id,
                item.shown,
              );
              return {
                kind: "done",
                text: `${r.id} route approved by ${r.by}. Next: ${r.next}`,
                warning: r.warning,
              };
            })
          }
        >
          Approve
        </Button>
        {busy && (
          <span className="text-xs text-muted-foreground">Recording…</span>
        )}
      </div>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

function StopBody({
  repoPath,
  item,
}: {
  repoPath: string;
  item: NeedsYouItem;
}) {
  const { busy, outcome, act } = useAction();
  return (
    <div className="space-y-2">
      <AnswerForm
        why={item.why}
        busy={busy}
        onAnswer={(allow, note) =>
          act(async () => {
            const r = await window.rivetari.tasks.answer(
              repoPath,
              item.id,
              allow,
              note,
            );
            return {
              kind: "done",
              text: `${r.id} ${r.answer} by ${r.by}. Next: ${r.next}`,
              warning: r.warning,
            };
          })
        }
      />
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

function Findings({
  label,
  findings,
}: {
  label: string;
  findings: NonNullable<NowJudge>["blocking"];
}) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1">
      <h5 className="text-xs font-semibold">{label}</h5>
      <ul className="space-y-1 text-xs">
        {findings.map((f, i) => (
          <li key={`${f.title}-${i}`}>
            <span className="text-amber-400">[{f.kind}]</span> {f.title}
            {f.file && (
              <span className="font-mono text-muted-foreground">
                {" "}
                {f.file}
                {f.line !== null ? `:${f.line}` : ""}
              </span>
            )}
            {f.detail && (
              <span className="block text-muted-foreground">{f.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JudgeBody({
  repoPath,
  item,
  onOpenTask,
}: {
  repoPath: string;
  item: NeedsYouItem;
  onOpenTask: (id: string) => void;
}) {
  const [judge, setJudge] = useState<NowJudge | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Read again whenever the task's ledger moves: a new round has a new record.
  useEffect(() => {
    let live = true;
    window.rivetari.now.judge(repoPath, item.id).then(
      (next) => {
        if (!live) return;
        setJudge(next);
        setError(null);
      },
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, item.id, item.ledgerSeq]);
  return (
    <div className="space-y-3">
      <p className="text-sm">{item.why}</p>
      {error && (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      )}
      {judge === undefined && !error ? (
        <p className="text-xs text-muted-foreground">
          Reading the judge&apos;s record…
        </p>
      ) : judge ? (
        <div className="space-y-2">
          <p className="text-xs">
            Round {judge.round}: {judge.verdict}
          </p>
          <Findings label="Blocking findings" findings={judge.blocking} />
          {judge.acceptance.length > 0 && (
            <div className="space-y-1">
              <h5 className="text-xs font-semibold">
                Acceptance criteria not met
              </h5>
              <ul className="space-y-0.5 text-xs">
                {judge.acceptance.map((a) => (
                  <li key={a.id}>
                    <span className="font-mono">{a.id}</span> {a.status}
                    {a.note && ` — ${a.note}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {judge.protectedPaths.length > 0 && (
            <div className="space-y-1">
              <h5 className="text-xs font-semibold">Protected paths</h5>
              <ul className="space-y-0.5 text-xs">
                {judge.protectedPaths.map((p) => (
                  <li key={p} className="font-mono">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {judge.notes.length > 0 && (
            <ul className="list-inside list-disc text-xs">
              {judge.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <Findings label="Suggestions" findings={judge.suggestions} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No judge verdict is recorded yet.
        </p>
      )}
      <PrLink repoPath={repoPath} item={item} />
      <NextLine next={item.next} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onOpenTask(item.id)}
      >
        Open {item.id} in Tasks
      </Button>
    </div>
  );
}

function ItemCard({
  repoPath,
  item,
  onOpenTask,
}: {
  repoPath: string;
  item: NeedsYouItem;
  onOpenTask: (id: string) => void;
}) {
  const headingId = `now-item-${item.id}-heading`;
  return (
    <article
      id={`now-item-${item.id}`}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="space-y-3 rounded-lg border border-amber-500/40 bg-card p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex items-start gap-3">
        <CircleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
          aria-hidden
        />
        <h4 id={headingId} className="min-w-0 flex-1 text-sm font-medium">
          <span className="font-mono text-xs text-muted-foreground">
            {item.id}
          </span>{" "}
          {item.title}
        </h4>
        <span className="shrink-0 text-xs text-amber-400">
          {KIND_LABEL[item.kind]}
        </span>
      </header>
      {item.kind === "intake" ? (
        <IntakeBody repoPath={repoPath} item={item} />
      ) : item.kind === "route" ? (
        <RouteBody repoPath={repoPath} item={item} />
      ) : item.kind === "stop" ? (
        <StopBody repoPath={repoPath} item={item} />
      ) : item.kind === "judge" ? (
        <JudgeBody repoPath={repoPath} item={item} onOpenTask={onOpenTask} />
      ) : item.kind === "merge" ? (
        <div className="space-y-2">
          <p className="text-sm">{item.why}</p>
          <PrLink repoPath={repoPath} item={item} />
          <NextLine next={item.next} />
        </div>
      ) : null}
      {(item.kind === "intake" ||
        item.kind === "route" ||
        item.kind === "stop" ||
        item.kind === "merge") && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onOpenTask(item.id)}
        >
          Open {item.id} in Tasks
        </Button>
      )}
      {item.kind === "record" && (
        <div className="space-y-2">
          <p className="text-sm text-rose-300">{item.why}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onOpenTask(item.id)}
          >
            Open {item.id} in Tasks
          </Button>
        </div>
      )}
    </article>
  );
}

function RunningRow({ task, now }: { task: NowRunning; now: number }) {
  const quiet = now - Date.parse(task.lastActivityAt);
  const parts = [
    task.beat,
    ...(task.lastTool === undefined ? [] : [`last tool ${task.lastTool}`]),
    ...(task.turns === undefined ? [] : [`turn ${task.turns}`]),
    span(now - Date.parse(task.startedAt)),
    usd(task.costUsd),
  ];
  return (
    <li className="space-y-0.5 px-4 py-2.5">
      <p className="flex items-center gap-2 text-sm">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {task.id}
        </span>
        <span className="truncate">{task.title}</span>
      </p>
      <p
        className={`text-xs ${quiet >= QUIET_MS ? "text-amber-400" : "text-sky-400"}`}
      >
        {parts.join(" · ")}
        {quiet >= QUIET_MS &&
          ` · No activity for ${Math.floor(quiet / 60_000)} min`}
      </p>
    </li>
  );
}

const RECENT_LABEL: Record<RecentEvent["kind"], string> = {
  merged: "merged",
  closed: "closed",
  abandoned: "abandoned",
  judged: "judged",
  stopped: "stopped",
  answered: "answered",
  shipped: "shipped",
};

function HealthStrip({
  repoPath,
  state,
}: {
  repoPath: string;
  state: NowState | null;
}) {
  const [health, setHealth] = useState<NowHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [ci, setCi] = useState<NowCi | null>(null);
  // Read again when the feed's newest event changes: a closed task moves the spend.
  const head = state?.recent[0];
  const headKey = head ? `${head.id}#${head.seq}` : "";
  const open = state?.openCostUsd ?? 0;
  useEffect(() => {
    let live = true;
    window.rivetari.now.health(repoPath).then(
      (next) => {
        if (!live) return;
        setHealth(next);
        setHealthError(null);
      },
      (err: unknown) => live && setHealthError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, headKey, state?.taskCount]);
  // CI reads GitHub; it never holds up the rest of the page.
  useEffect(() => {
    let live = true;
    window.rivetari.now.ci(repoPath).then(
      (next) => live && setCi(next),
      (err: unknown) =>
        live &&
        setCi({
          state: "unavailable",
          branch: null,
          url: null,
          detail: errorMessage(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [repoPath]);

  const cell = "space-y-0.5 p-3";
  return (
    <section aria-labelledby="now-health" className="space-y-2">
      <h3 id="now-health" className="text-sm font-semibold">
        Health
      </h3>
      {healthError && (
        <p className="text-xs text-rose-300" role="alert">
          {healthError}
        </p>
      )}
      <Card className="grid grid-cols-2 divide-border text-xs lg:grid-cols-4">
        <div className={cell}>
          <p className="font-medium">Autonomy</p>
          {health ? (
            health.autonomy.error ? (
              <p className="text-rose-300">{health.autonomy.error}</p>
            ) : (
              <p>
                {health.autonomy.configured === null ? (
                  "no profile to read a level from"
                ) : (
                  <>
                    {health.autonomy.configured}{" "}
                    <span className="text-muted-foreground">(configured)</span>
                  </>
                )}
              </p>
            )
          ) : (
            <p className="text-muted-foreground">Reading…</p>
          )}
          <p className="text-muted-foreground">
            effective level: run <code>rivetari autonomy</code>
          </p>
        </div>
        <div className={cell}>
          <p className="font-medium">Spend</p>
          {health ? (
            <>
              <p>
                {usd(health.spend.todayUsd)} today · {usd(health.spend.weekUsd)}{" "}
                last 7 days
              </p>
              <p className="text-muted-foreground">{usd(open)} on open tasks</p>
              {health.spend.error && (
                <p className="text-rose-300">{health.spend.error}</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Reading…</p>
          )}
        </div>
        <div className={cell}>
          <p className="font-medium">Skills</p>
          {health ? (
            health.skills.error ? (
              <p className="text-rose-300">{health.skills.error}</p>
            ) : (
              <>
                <p>
                  {health.skills.locked} locked · {health.skills.installed}{" "}
                  installed · {health.skills.gaps.length}{" "}
                  {health.skills.gaps.length === 1 ? "gap" : "gaps"}
                </p>
                {health.skills.gaps.length > 0 && (
                  <p className="text-muted-foreground">
                    {health.skills.gaps.join("; ")}
                  </p>
                )}
                {health.skills.problems.map((p) => (
                  <p key={p} className="text-amber-400">
                    {p}
                  </p>
                ))}
              </>
            )
          ) : (
            <p className="text-muted-foreground">Reading…</p>
          )}
        </div>
        <div className={cell}>
          <p className="font-medium">main&apos;s CI</p>
          {ci ? (
            <p
              className={
                ci.state === "failing"
                  ? "text-rose-300"
                  : ci.state === "passing"
                    ? "text-emerald-400"
                    : ci.state === "running"
                      ? "text-sky-400"
                      : "text-muted-foreground"
              }
            >
              {ci.url && isHttps(ci.url) ? (
                <a
                  href={ci.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {ci.detail}
                </a>
              ) : (
                ci.detail
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">Checking…</p>
          )}
        </div>
      </Card>
    </section>
  );
}

export function Now({
  repoPath,
  focus,
  onOpenTask,
}: {
  repoPath: string;
  /** An item to bring into view (a clicked notification); `seq` repeats it. */
  focus: { id: string; seq: number } | null;
  onOpenTask: (id: string) => void;
}) {
  const [state, setState] = useState<NowState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.rivetari.now.onUpdate((next) => {
      if (active && next.repoPath === repoPath) setState(next);
    });
    window.rivetari.now.get(repoPath).then(
      (first) => active && setState((current) => current ?? first),
      (err: unknown) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [repoPath]);

  const focused = useRef(0);
  useEffect(() => {
    if (!focus || focus.seq === focused.current) return;
    const el = document.getElementById(`now-item-${focus.id}`);
    if (!el) return;
    focused.current = focus.seq;
    el.scrollIntoView({ block: "center" });
    el.focus();
  }, [focus, state]);

  const running = state?.running ?? [];
  const now = useNow(running.length > 0);
  const ready = state?.ready ?? false;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Now</h2>
        <p className="text-xs text-muted-foreground">
          What&apos;s running, what waits on you and what just happened, read
          from the tasks&apos; records. Confirm a card, approve a route or
          answer a stop here; each is recorded the way{" "}
          <code>rivetari task</code> records it.
        </p>
      </div>

      <HealthStrip repoPath={repoPath} state={state} />

      {(error ?? state?.error) && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {error ?? state?.error}
        </p>
      )}

      {!ready && !error ? (
        <p className="text-sm text-muted-foreground">Reading tasks…</p>
      ) : state?.taskCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks in this repository yet. Start one with{" "}
          <code>/rivetari &lt;ask&gt;</code> in Claude Code, or{" "}
          <code>rivetari task new</code>.
        </p>
      ) : (
        <>
          <section aria-labelledby="now-needs-you" className="space-y-2">
            <h3 id="now-needs-you" className="text-sm font-semibold">
              Needs you
              {state && state.needsYou.length > 0 && (
                <span className="ml-2 text-xs font-normal text-amber-400">
                  {state.needsYou.length} waiting
                </span>
              )}
            </h3>
            {state && state.needsYou.length > 0 ? (
              <ul className="space-y-3">
                {state.needsYou.map((item) => (
                  <li key={`${item.id}-${item.kind}`}>
                    <ItemCard
                      repoPath={repoPath}
                      item={item}
                      onOpenTask={onOpenTask}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nothing waits on a person.
              </p>
            )}
          </section>

          <section aria-labelledby="now-running" className="space-y-2">
            <h3 id="now-running" className="text-sm font-semibold">
              Running
            </h3>
            {running.length > 0 ? (
              <Card>
                <ul className="divide-y divide-border/60">
                  {running.map((t) => (
                    <RunningRow key={t.id} task={t} now={now} />
                  ))}
                </ul>
              </Card>
            ) : (
              <p className="text-xs text-muted-foreground">
                No beat is running on this machine.
              </p>
            )}
          </section>

          <section aria-labelledby="now-recent" className="space-y-2">
            <h3 id="now-recent" className="text-sm font-semibold">
              Recent
            </h3>
            {state && state.recent.length > 0 ? (
              <Card>
                <ol className="divide-y divide-border/60">
                  {state.recent.map((e) => (
                    <li key={`${e.id}-${e.seq}`}>
                      <button
                        type="button"
                        onClick={() => onOpenTask(e.id)}
                        className="flex w-full items-start gap-3 px-4 py-2 text-left text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="w-28 shrink-0 tabular-nums text-muted-foreground">
                          {when(e.at)}
                        </span>
                        <span className="w-20 shrink-0 text-sky-400">
                          {RECENT_LABEL[e.kind]}
                        </span>
                        <span className="min-w-0 flex-1 break-words">
                          <span className="font-mono text-muted-foreground">
                            {e.id}
                          </span>{" "}
                          {e.title}: {e.text}
                          <span className="ml-1 text-muted-foreground">
                            ({e.by})
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </Card>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nothing has happened on these tasks yet.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
