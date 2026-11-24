import {
  CircleAlert,
  CircleCheck,
  CircleX,
  GitPullRequest,
  Hand,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { when } from "@/lib/time";

import type {
  CriterionStatus,
  TaskCriterion,
  TaskDetail,
  TaskFinding,
  TaskJudgeRound,
  TaskPrState,
  TaskProof,
  TaskSummary,
} from "../../shared/ipc";

// One task in full, under the Tasks tab's summary of it: the card with each
// criterion's status, the route, the plan, the proof, every judge round and
// the PR as GitHub has it. All of it is the main process's reading of the
// records; nothing here acts. A part that can't be read says so in place, as
// text rather than an alert, so it doesn't speak over the summary's own.

/** Shown on every UI screenshot proof until the runtime's R-25 is fixed. */
export const R25_WARNING =
  "Rivetari's UI screenshots may show the loading state (known issue R-25): check the page loaded.";

const list = (items: string[]) =>
  items.length > 0 ? items.join(", ") : "none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

/** A titled part of the detail, a region of its own. */
function Part({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h4 id={id} className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        {aside && (
          <span className="text-xs font-normal text-muted-foreground">
            {aside}
          </span>
        )}
      </h4>
      {children}
    </section>
  );
}

const Unreadable = ({ text }: { text: string }) => (
  <p className="text-xs text-rose-300">{text}</p>
);

const STATUS: Record<
  CriterionStatus,
  { label: string; className: string; icon: typeof CircleCheck }
> = {
  met: {
    label: "met",
    className: "border-emerald-500/40 text-emerald-300",
    icon: CircleCheck,
  },
  unmet: {
    label: "unmet",
    className: "border-rose-400 bg-rose-500/20 font-semibold text-rose-200",
    icon: CircleX,
  },
  unverified: {
    label: "unverified",
    className: "border-amber-400 bg-amber-500/20 font-semibold text-amber-200",
    icon: TriangleAlert,
  },
  "hand-checked": {
    label: "hand-checked",
    className: "border-sky-500/40 text-sky-300",
    icon: Hand,
  },
  "not judged": {
    label: "not judged",
    className: "border-border text-muted-foreground",
    icon: CircleAlert,
  },
};

/** Unmet and unverified are what a person must look at: they stand out. */
const standsOut = (s: CriterionStatus) => s === "unmet" || s === "unverified";

function Criterion({ c }: { c: TaskCriterion }) {
  const status = STATUS[c.status];
  const Icon = status.icon;
  return (
    <li
      className={`flex gap-3 rounded-md border px-3 py-2 text-xs ${
        standsOut(c.status) ? status.className : "border-border/60"
      }`}
    >
      <span className="w-8 shrink-0 font-mono text-muted-foreground">
        {c.id}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-foreground">{c.text}</span>
        <span className="block text-muted-foreground">
          verified by {c.verify}
          {c.note && ` · ${c.note}`}
        </span>
      </span>
      <span
        className={`flex h-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 ${status.className}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {status.label}
      </span>
    </li>
  );
}

function CardPart({ detail }: { detail: TaskDetail }) {
  const { card } = detail;
  if (!card)
    return (
      <Part title="Card">
        <Unreadable text="The card couldn't be read from the record." />
      </Part>
    );
  const counts = card.acceptance.reduce<Record<string, number>>(
    (n, c) => ({ ...n, [c.status]: (n[c.status] ?? 0) + 1 }),
    {},
  );
  const tally = Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
  return (
    <Part title="Card">
      <p className="text-sm">{card.description}</p>
      <dl className="space-y-1">
        <Field label="Type and risk">
          {card.type} · {card.risk} risk
        </Field>
        {card.touches.length > 0 && (
          <Field label="Touches">{card.touches.join(", ")}</Field>
        )}
        <Field label="Out of scope">
          {card.outOfScope.length > 0
            ? card.outOfScope.join("; ")
            : "nothing named"}
        </Field>
      </dl>
      <div className="space-y-1.5">
        <h5 className="text-xs font-semibold">
          Acceptance criteria{" "}
          <span className="font-normal text-muted-foreground">
            {detail.judgedRound === null
              ? "(no judge round yet)"
              : `(judge round ${detail.judgedRound}: ${tally})`}
          </span>
        </h5>
        <ul aria-label="Acceptance criteria" className="space-y-1.5">
          {card.acceptance.map((c) => (
            <Criterion key={c.id} c={c} />
          ))}
        </ul>
      </div>
    </Part>
  );
}

function RoutePart({ route }: { route: TaskDetail["route"] }) {
  if (!route)
    return (
      <Part title="Route">
        <p className="text-xs text-muted-foreground">
          Not routed yet: the router proposes a route once the card is
          confirmed.
        </p>
      </Part>
    );
  const a = route.assembly;
  return (
    <Part
      title="Route"
      aside={route.approved ? "approved" : "waiting for approval"}
    >
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
          <Field label="Gaps">
            {a.gaps.length > 0 ? (
              <span className="text-amber-300">{a.gaps.join("; ")}</span>
            ) : (
              "none"
            )}
          </Field>
          <Field label="Checks">{list(a.checks)}</Field>
          <Field label="Proof">{a.proof}</Field>
          <Field label="Budget">
            {a.budget.skillTokens.toLocaleString()} skill tokens ·{" "}
            {a.budget.contextTokens.toLocaleString()} context tokens ·{" "}
            {a.budget.steps} steps
          </Field>
          <Field label="Stop and ask">{list(a.stopAndAsk)}</Field>
        </dl>
      ) : (
        <ul
          className="list-inside list-disc text-xs text-rose-300"
          aria-label="Why the assembly can't be read"
        >
          {route.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {route.reasons.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold">Why the router chose it</h5>
          <ul className="list-inside list-disc space-y-0.5 text-xs">
            {route.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </Part>
  );
}

function PlanPart({ plan }: { plan: string[] }) {
  return (
    <Part title="Plan">
      {plan.length > 0 ? (
        <ol className="list-inside list-decimal space-y-0.5 text-xs">
          {plan.map((step, i) => (
            <li key={`${i}-${step}`}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          No plan is recorded yet: the build beat writes one before it edits
          anything.
        </p>
      )}
    </Part>
  );
}

const kb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function ProofBody({ proof }: { proof: TaskProof }) {
  return (
    <div className="space-y-3">
      <p className="text-xs">
        <span className={proof.passed ? "text-emerald-400" : "text-rose-300"}>
          {proof.passed ? "Passed" : "Failed"}
        </span>{" "}
        · {proof.kind}
        {proof.tests &&
          ` · tests exit ${proof.tests.exitCode}${proof.tests.outcome ? ` (${proof.tests.outcome})` : ""}`}
      </p>
      {proof.lines.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 break-words text-xs">
          {proof.lines.map((l, i) => (
            <li key={`${i}-${l}`}>{l}</li>
          ))}
        </ul>
      )}
      {proof.tests && proof.tests.added.length > 0 && (
        <div className="space-y-0.5 text-xs">
          <h5 className="font-semibold">New tests</h5>
          <ul className="list-inside list-disc font-mono">
            {proof.tests.added.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {proof.ui && (
        <p className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {R25_WARNING}
        </p>
      )}
      {proof.shots.length > 0 && (
        <ul
          aria-label="Screenshots"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {proof.shots.map((s) => (
            <li key={`${s.side}-${s.page}-${s.breakpoint}-${s.file}`}>
              <figure className="space-y-1 rounded-md border border-border/60 p-2">
                {s.dataUrl ? (
                  <img
                    src={s.dataUrl}
                    alt={`${s.side} screenshot of ${s.page} at ${s.breakpoint}`}
                    className="max-h-64 w-full rounded object-contain object-top"
                  />
                ) : (
                  <p className="text-xs text-rose-300">
                    {s.file}: {s.problem}
                  </p>
                )}
                <figcaption className="text-xs text-muted-foreground">
                  {s.side} · {s.page} · {s.breakpoint} · HTTP {s.status}
                  {s.width !== null &&
                    s.height !== null &&
                    ` · ${s.width}×${s.height}`}
                  {s.bytes !== null && ` · ${kb(s.bytes)}`} · {s.file}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
      {proof.ui && (
        <div className="space-y-1 text-xs">
          <h5 className="font-semibold">
            axe{" "}
            <span className="font-normal text-muted-foreground">
              (on the change)
            </span>
          </h5>
          {proof.violations.length === 0 ? (
            <p>No violations.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Rule
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Impact
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Page
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Nodes
                  </th>
                </tr>
              </thead>
              <tbody>
                {proof.violations.map((v) => (
                  <tr
                    key={`${v.id}-${v.page}`}
                    className="border-t border-border/60"
                  >
                    <td className="py-1 font-mono">{v.id}</td>
                    <td
                      className={`py-1 ${v.impact === "serious" || v.impact === "critical" ? "text-rose-300" : ""}`}
                    >
                      {v.impact}
                    </td>
                    <td className="py-1">{v.page}</td>
                    <td className="py-1 text-right tabular-nums">{v.nodes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {proof.testRun !== null && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold">
            test-run.txt
          </summary>
          <pre
            tabIndex={0}
            aria-label="test-run.txt"
            className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background p-2 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {proof.testRun}
          </pre>
        </details>
      )}
    </div>
  );
}

function ProofPart({ proof }: { proof: TaskDetail["proof"] }) {
  return (
    <Part title="Proof" aside="from this machine's copy">
      {proof.error && <Unreadable text={proof.error} />}
      {proof.record ? (
        <ProofBody proof={proof.record} />
      ) : (
        !proof.error && (
          <p className="text-xs text-muted-foreground">
            No proof on this machine yet: the prove beat writes it.
          </p>
        )
      )}
    </Part>
  );
}

function Findings({
  label,
  findings,
  tone,
}: {
  label: string;
  findings: TaskFinding[];
  tone: string;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1">
      <h6 className="text-xs font-semibold">
        {label} ({findings.length})
      </h6>
      <ul className="space-y-1.5 text-xs">
        {findings.map((f, i) => (
          <li key={`${f.title}-${i}`} className="break-words">
            <span className={tone}>[{f.kind}]</span>
            {f.acceptanceId && (
              <span className="font-mono"> ({f.acceptanceId})</span>
            )}{" "}
            {f.title}
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
            {f.repro && (
              <span className="block text-muted-foreground">
                Repro: {f.repro}
              </span>
            )}
            {f.fix && (
              <span className="block text-muted-foreground">Fix: {f.fix}</span>
            )}
            {f.downgraded && (
              <span className="block text-muted-foreground">
                Downgraded from blocking: {f.downgraded}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = {
  passed: "text-emerald-400",
  failed: "text-rose-300",
  "needs a human": "text-amber-300",
};

function Round({ r }: { r: TaskJudgeRound }) {
  const id = useId();
  return (
    <article
      aria-labelledby={id}
      className="space-y-2 rounded-md border border-border/60 p-3"
    >
      <h5 id={id} className="text-xs font-semibold">
        Round {r.round}:{" "}
        <span className={VERDICT_TONE[r.verdict] ?? ""}>{r.verdict}</span>
        <span className="font-normal text-muted-foreground">
          {" "}
          · {when(r.at)}
          {r.head && ` · head ${r.head.slice(0, 12)}`}
        </span>
      </h5>
      {r.problem && <Unreadable text={r.problem} />}
      {r.tier1 && (
        <div className="space-y-1 text-xs">
          <h6 className="font-semibold">Tier 1: {r.tier1.verdict}</h6>
          {r.tier1.checks.length > 0 && (
            <ul className="space-y-0.5">
              {r.tier1.checks.map((c) => (
                <li key={c.id} className="break-words">
                  <span
                    className={
                      c.outcome === "fail"
                        ? "text-rose-300"
                        : c.outcome === "pre-existing"
                          ? "text-amber-300"
                          : "text-emerald-400"
                    }
                  >
                    {c.outcome}
                  </span>{" "}
                  <span className="font-mono">{c.id}</span>
                  {c.outcome !== "pass" && c.message && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {c.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {r.tier1.protectedPaths.length > 0 && (
            <ul aria-label="Protected paths" className="space-y-0.5">
              {r.tier1.protectedPaths.map((p) => (
                <li key={p} className="font-mono text-amber-300">
                  protected: {p}
                </li>
              ))}
            </ul>
          )}
          {r.tier1.notes.map((n) => (
            <p key={n} className="text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      )}
      {r.review ? (
        <div className="space-y-2 text-xs">
          <h6 className="font-semibold">
            Review: {r.review.verdict}{" "}
            <span className="font-normal text-muted-foreground">
              ({r.review.model})
            </span>
          </h6>
          <Findings
            label="Blocking"
            findings={r.review.blocking}
            tone="text-rose-300"
          />
          <Findings
            label="Suggestions"
            findings={r.review.suggestions}
            tone="text-sky-300"
          />
          {r.review.blocking.length === 0 &&
            r.review.suggestions.length === 0 && <p>No findings.</p>}
          {r.review.acceptance.length > 0 && (
            <ul className="space-y-0.5">
              {r.review.acceptance.map((a) => (
                <li key={a.id}>
                  <span className="font-mono">{a.id}</span> {a.status}
                  {a.note && ` — ${a.note}`}
                </li>
              ))}
            </ul>
          )}
          {r.review.unreviewed.length > 0 && (
            <p className="text-amber-300">
              Not shown to the reviewer: {r.review.unreviewed.join(", ")}
            </p>
          )}
        </div>
      ) : (
        r.tier1 && (
          <p className="text-xs text-muted-foreground">
            The review didn&apos;t run: tier 1 decided the round.
          </p>
        )
      )}
      {r.risk && r.risk.effective !== r.risk.card && (
        <p className="text-xs text-amber-300">
          Risk raised to {r.risk.effective} from the card&apos;s {r.risk.card}:{" "}
          {r.risk.reasons.join("; ")}
        </p>
      )}
    </article>
  );
}

function JudgePart({ judge }: { judge: TaskDetail["judge"] }) {
  const latest = judge.rounds.at(-1);
  return (
    <Part
      title="Judge"
      aside={
        latest
          ? `verdict: ${latest.verdict} (round ${latest.round})`
          : undefined
      }
    >
      {judge.error && <Unreadable text={judge.error} />}
      {judge.rounds.length > 0 ? (
        <div className="space-y-2">
          {judge.rounds.map((r) => (
            <Round key={r.round} r={r} />
          ))}
        </div>
      ) : (
        !judge.error && (
          <p className="text-xs text-muted-foreground">Not judged yet.</p>
        )
      )}
    </Part>
  );
}

/** Everything the record holds about the task, fetched again as its ledger moves. */
export function TaskRecord({
  repoPath,
  task,
}: {
  repoPath: string;
  task: TaskSummary;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.rivetari.tasks.detail(repoPath, task.id).then(
      (next) => {
        if (!live) return;
        setDetail(next);
        setError(null);
      },
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, task.id, task.ledgerSeq]);

  if (error && !detail) return <Unreadable text={error} />;
  if (!detail)
    return <p className="text-xs text-muted-foreground">Reading the record…</p>;
  return (
    <div className="space-y-5">
      {error && <Unreadable text={error} />}
      <CardPart detail={detail} />
      <RoutePart route={detail.route} />
      <PlanPart plan={detail.plan} />
      <ProofPart proof={detail.proof} />
      <JudgePart judge={detail.judge} />
    </div>
  );
}

const CHECK_TONE = (c: TaskPrState["checks"][number]) =>
  c.status !== "completed"
    ? "text-sky-300"
    : c.conclusion === "success" ||
        c.conclusion === "skipped" ||
        c.conclusion === "neutral"
      ? "text-emerald-400"
      : "text-rose-300";

/**
 * The PR: its link (opened by the main process from the ledger's URL) and,
 * when signed in, its state and check runs on GitHub. It's read on its own,
 * so the rest of the detail never waits on GitHub.
 */
export function PrPart({
  repoPath,
  task,
  link,
}: {
  repoPath: string;
  task: TaskSummary;
  /** The PR link, from the summary that opens it. */
  link: ReactNode;
}) {
  const [pr, setPr] = useState<TaskPrState | null>(null);
  const [round, setRound] = useState(0);
  const number = task.pr?.number ?? null;
  useEffect(() => {
    if (number === null) return;
    let live = true;
    setPr(null);
    window.rivetari.tasks.pr(repoPath, task.id).then(
      (next) => live && setPr(next),
      (err: unknown) =>
        live &&
        setPr({
          state: "unavailable",
          number,
          draft: null,
          mergeable: null,
          mergeableState: null,
          headSha: null,
          checks: [],
          detail: errorMessage(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [repoPath, task.id, number, task.ledgerSeq, round]);

  return (
    <Part title="Pull request">
      {number === null ? (
        <p className="text-xs text-muted-foreground">
          No PR yet: the ship beat opens a draft PR once the judge passes it.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <GitPullRequest className="h-4 w-4 text-sky-400" aria-hidden />
            {link}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pr === null}
              onClick={() => setRound((n) => n + 1)}
            >
              Refresh from GitHub
            </Button>
          </div>
          {pr === null ? (
            <p className="text-xs text-muted-foreground">
              Reading the PR from GitHub…
            </p>
          ) : (
            <>
              <p
                className={`text-xs ${
                  pr.state === "merged"
                    ? "text-emerald-400"
                    : pr.state === "open"
                      ? "text-sky-300"
                      : pr.state === "closed"
                        ? "text-rose-300"
                        : "text-muted-foreground"
                }`}
              >
                {pr.detail}
                {pr.headSha && (
                  <span className="text-muted-foreground">
                    {" "}
                    · head {pr.headSha.slice(0, 12)}
                  </span>
                )}
              </p>
              {pr.checks.length > 0 ? (
                <table
                  aria-label="Check runs on the PR's head"
                  className="w-full text-left text-xs"
                >
                  <thead className="text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1 font-medium">
                        Check
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Status
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Conclusion
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Head
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pr.checks.map((c, i) => (
                      <tr
                        key={`${c.name}-${i}`}
                        className="border-t border-border/60"
                      >
                        <td className="py-1">{c.name}</td>
                        <td className="py-1">{c.status}</td>
                        <td className={`py-1 ${CHECK_TONE(c)}`}>
                          {c.conclusion ?? "—"}
                        </td>
                        <td className="py-1 font-mono">
                          {c.headSha.slice(0, 7)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                (pr.state === "open" ||
                  pr.state === "merged" ||
                  pr.state === "closed") && (
                  <p className="text-xs text-muted-foreground">
                    No check runs on the PR&apos;s head.
                  </p>
                )
              )}
            </>
          )}
        </div>
      )}
    </Part>
  );
}
