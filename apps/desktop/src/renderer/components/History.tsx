import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { when } from "@/lib/time";

import type { ClosedTaskItem, HistoryView, SpendDay } from "../../shared/ipc";

type OutcomeFilter = "all" | ClosedTaskItem["outcome"];

const OUTCOME_STYLE: Record<
  ClosedTaskItem["outcome"],
  { label: string; badge: string }
> = {
  merged: {
    label: "Merged",
    badge: "bg-emerald-500/20 text-emerald-300",
  },
  closed: {
    label: "Closed",
    badge: "bg-slate-500/20 text-slate-300",
  },
  abandoned: {
    label: "Abandoned",
    badge: "bg-amber-500/20 text-amber-200",
  },
};

const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const pct = (n: number | null) =>
  n === null ? "–" : `${Math.round(n * 100)}%`;
const mins = (n: number | null) => (n === null ? "–" : `${n.toFixed(1)} min`);

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      )}
    </Card>
  );
}

const SPEND_SERIES = [
  {
    key: "mergedUsd",
    label: "Merged",
    stroke: "stroke-emerald-500",
    swatch: "bg-emerald-500",
  },
  {
    key: "abandonedUsd",
    label: "Abandoned",
    stroke: "stroke-amber-500",
    swatch: "bg-amber-500",
  },
  {
    key: "closedUsd",
    label: "Closed",
    stroke: "stroke-slate-400",
    swatch: "bg-slate-400",
  },
] as const;

const W = 600;
const H = 150;
const PAD = { top: 10, right: 12, bottom: 22, left: 42 };

function spendReadout(d: SpendDay): string {
  return `${d.date}: ${usd(d.mergedUsd)} merged (${d.merged}), ${usd(d.abandonedUsd)} abandoned, ${usd(d.closedUsd)} closed`;
}

function spendPath(
  points: SpendDay[],
  key: "mergedUsd" | "abandonedUsd" | "closedUsd",
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  return points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`,
    )
    .join("");
}

function SpendTrend({ days }: { days: SpendDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();

  if (days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No closed tasks yet. Closing or abandoning a task appends a row to
        .rivetari/history.jsonl.
      </p>
    );
  }

  const max = Math.max(
    1,
    ...days.map((d) => Math.max(d.mergedUsd, d.abandonedUsd, d.closedUsd)),
  );
  const span = W - PAD.left - PAD.right;
  const x = (i: number) =>
    PAD.left + (days.length === 1 ? span / 2 : (i * span) / (days.length - 1));
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / max);
  const last = days[days.length - 1];
  const shown = days[active ?? days.length - 1];
  const step = days.length > 1 ? span / (days.length - 1) : span;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul
          aria-label="Spend trend legend"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {SPEND_SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                className={`h-0.5 w-3 rounded-full ${s.swatch}`}
                aria-hidden
              />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-medium tabular-nums">
                {last ? usd(last[s.key]) : "–"}
              </span>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? "Show as chart" : "Show as table"}
        </Button>
      </div>

      {asTable ? (
        <table className="w-full text-left text-xs tabular-nums">
          <caption className="sr-only">Spend by day, oldest first</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Date
              </th>
              <th scope="col" className="py-1 font-medium">
                Merged PRs
              </th>
              <th scope="col" className="py-1 font-medium">
                Merged spend
              </th>
              <th scope="col" className="py-1 font-medium">
                Abandoned spend
              </th>
              <th scope="col" className="py-1 font-medium">
                Closed spend
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-t border-border/60">
                <td className="py-1">{d.date}</td>
                <td className="py-1">{d.merged}</td>
                <td className="py-1">{usd(d.mergedUsd)}</td>
                <td className="py-1">{usd(d.abandonedUsd)}</td>
                <td className="py-1">{usd(d.closedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full"
            role="img"
            aria-labelledby={titleId}
            onMouseLeave={() => setActive(null)}
          >
            <title id={titleId}>
              {`Spend trend over ${days.length} closing days, from ${days[0]?.date} to ${last?.date}. Latest: ${last ? spendReadout(last) : ""}.`}
            </title>
            {[0, max].map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y(v)}
                  y2={y(v)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 6}
                  y={y(v) + 3}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {`$${v.toFixed(0)}`}
                </text>
              </g>
            ))}
            <text
              x={x(0)}
              y={H - 6}
              textAnchor={days.length === 1 ? "middle" : "start"}
              className="fill-muted-foreground text-[10px]"
            >
              {days[0]?.date}
            </text>
            {days.length > 1 && (
              <text
                x={x(days.length - 1)}
                y={H - 6}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {last?.date}
              </text>
            )}
            {SPEND_SERIES.map((s) =>
              days.length === 1 ? (
                <circle
                  key={s.key}
                  cx={x(0)}
                  cy={y(days[0]![s.key])}
                  r={3.5}
                  className={`${s.stroke} fill-background`}
                  strokeWidth={2}
                />
              ) : (
                <path
                  key={s.key}
                  d={spendPath(days, s.key, x, y)}
                  fill="none"
                  className={s.stroke}
                  strokeWidth={2}
                />
              ),
            )}
            {shown && (
              <line
                x1={x(active ?? days.length - 1)}
                x2={x(active ?? days.length - 1)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                className="stroke-foreground/30"
                strokeWidth={1}
              />
            )}
            {days.map((d, i) => (
              <rect
                key={d.date}
                x={x(i) - step / 2}
                y={PAD.top}
                width={step}
                height={H - PAD.top - PAD.bottom}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              />
            ))}
          </svg>
          {shown && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {spendReadout(shown)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Findings({ findings }: { findings: HistoryView["findings"] }) {
  return (
    <section aria-labelledby="history-findings" className="space-y-3">
      <h3 id="history-findings" className="text-sm font-semibold">
        Judge findings
      </h3>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs tabular-nums">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Tier 1 rules</dt>
          <dd className="font-medium">
            {findings.tier1Rules.total} ({findings.tier1Rules.catalog} checks,{" "}
            {findings.tier1Rules.diff} diff)
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Reviewed</dt>
          <dd className="font-medium">{findings.reviewed}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Blocking per PR</dt>
          <dd className="font-medium">
            {findings.findingsPerPr === null
              ? "–"
              : findings.findingsPerPr.toFixed(2)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Suggestions</dt>
          <dd className="font-medium">{findings.suggestions}</dd>
        </div>
      </dl>

      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">
          Candidate rules (a pattern seen in 2+ PRs)
        </h4>
        {findings.candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {findings.candidates.map((c) => (
              <li
                key={c.pattern}
                className="rounded border border-border/60 px-2.5 py-1.5"
              >
                <span className="font-mono">{c.pattern}</span> · {c.kind}:{" "}
                {c.title} ({c.prs.join(", ")})
              </li>
            ))}
          </ul>
        )}
      </div>

      {findings.patterns.length > 0 ? (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Judge finding patterns and the PRs they recurred in
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Pattern
              </th>
              <th scope="col" className="py-1 font-medium">
                Kind
              </th>
              <th scope="col" className="py-1 font-medium">
                Title
              </th>
              <th scope="col" className="py-1 font-medium">
                PRs
              </th>
            </tr>
          </thead>
          <tbody>
            {findings.patterns.map((p) => (
              <tr key={p.pattern} className="border-t border-border/60">
                <td className="py-1 font-mono">{p.pattern}</td>
                <td className="py-1">{p.kind}</td>
                <td className="py-1">{p.title}</td>
                <td className="py-1">{p.prs.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">
          No judge findings recorded yet.
        </p>
      )}
    </section>
  );
}

function CostFlags({ flags }: { flags: HistoryView["costFlags"] }) {
  return (
    <section aria-labelledby="history-cost-flags" className="space-y-2">
      <h3 id="history-cost-flags" className="text-sm font-semibold">
        Cost flags
      </h3>
      <p className="text-xs text-muted-foreground">
        Low-risk tasks that cost over $1, as rivetari metrics flags them.
      </p>
      {flags.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None: no low-risk task cost over $1.
        </p>
      ) : (
        <ul className="space-y-1 text-xs tabular-nums">
          {flags.map((c) => (
            <li
              key={c.task}
              className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-200"
            >
              {c.task} · {usd(c.costUsd)}
              {c.promptTokens !== null
                ? ` · ${c.promptTokens} prompt tokens`
                : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function History({
  repoPath,
  onOpenTask,
}: {
  repoPath: string;
  /** Show a task's detail in the Tasks tab. */
  onOpenTask: (id: string) => void;
}) {
  const [data, setData] = useState<HistoryView | null>(null);
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await window.rivetari.history.get(repoPath));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredTasks = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.tasks;
    return data.tasks.filter((t) => t.outcome === filter);
  }, [data, filter]);

  async function openPr(id: string): Promise<void> {
    setPrError(null);
    try {
      await window.rivetari.history.openPr(repoPath, id);
    } catch (err) {
      setPrError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">History</h2>
          {data && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {data.summary.tasks} closed · {data.summary.merged} merged ·{" "}
              {usd(data.summary.spend.totalUsd)} spent
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {error}
        </p>
      )}

      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading history…</p>
      ) : data ? (
        <div className="space-y-6">
          {data.problems.length > 0 && (
            <ul
              className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
              aria-label="What couldn't be read"
            >
              {data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <section aria-labelledby="history-summary" className="space-y-2">
            <h3 id="history-summary" className="text-sm font-semibold">
              Spend
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Total spend"
                value={usd(data.summary.spend.totalUsd)}
                hint={`${usd(data.summary.spend.perMergedUsd)} per merged task`}
              />
              <MetricCard
                label="Median merged task"
                value={usd(data.summary.spend.mergedMedianUsd)}
                hint={`Abandoned share: ${pct(data.summary.spend.abandonedShare)}`}
              />
              <MetricCard
                label="Judge share"
                value={pct(data.summary.judge.share)}
                hint={`${usd(data.summary.judge.costUsd)} over ${data.summary.judge.tasks} task(s)`}
              />
              <MetricCard
                label="Median card to PR"
                value={mins(data.summary.cardToPr.medianMinutes)}
                hint={`Retry share: ${pct(data.summary.rounds.retryShare)} (${data.summary.rounds.multiBuild} multi-build)`}
              />
            </div>
          </section>

          <section aria-labelledby="history-spend-trend" className="space-y-2">
            <h3 id="history-spend-trend" className="text-sm font-semibold">
              Cost trend
            </h3>
            <SpendTrend days={data.summary.trend} />
          </section>

          <Findings findings={data.findings} />

          <CostFlags flags={data.costFlags} />

          <section aria-labelledby="history-tasks" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="history-tasks" className="text-sm font-semibold">
                Closed tasks
              </h3>
              <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label="Filter by outcome"
              >
                {(["all", "merged", "closed", "abandoned"] as const).map(
                  (kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant={filter === kind ? "secondary" : "ghost"}
                      aria-pressed={filter === kind}
                      onClick={() => setFilter(kind)}
                    >
                      {kind === "all"
                        ? `All (${data.summary.tasks})`
                        : `${OUTCOME_STYLE[kind].label} (${data.summary[kind]})`}
                    </Button>
                  ),
                )}
              </div>
            </div>

            {prError && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-rose-300"
                role="alert"
              >
                {prError}
              </p>
            )}

            {filteredTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {data.summary.tasks === 0
                  ? "No closed tasks yet."
                  : "No closed tasks match this filter."}
              </p>
            ) : (
              <table className="w-full text-left text-xs tabular-nums">
                <caption className="sr-only">
                  Closed tasks, newest first
                </caption>
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      Task
                    </th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      PR
                    </th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      Spend
                    </th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      Rounds
                    </th>
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      Time
                    </th>
                    <th scope="col" className="py-1.5 font-medium">
                      Closed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map((t) => {
                    const meta = OUTCOME_STYLE[t.outcome];
                    return (
                      <tr
                        key={t.id}
                        className="border-t border-border/60 align-top"
                      >
                        <th
                          scope="row"
                          className="py-2 pr-2 text-left font-normal"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenTask(t.id)}
                            className="rounded text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t.id}
                            {t.title ? ` · ${t.title}` : ""}
                          </button>
                          {t.risk && (
                            <div className="text-muted-foreground">
                              risk: {t.risk}
                              {t.skills.length > 0
                                ? ` · ${t.skills.join(", ")}`
                                : ""}
                            </div>
                          )}
                          {t.ledgerProblem && (
                            <p className="mt-0.5 text-amber-300">
                              {t.ledgerProblem}
                            </p>
                          )}
                        </th>
                        <td className="py-2 pr-2">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.badge}`}
                          >
                            {meta.label}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          {t.pr === null ? (
                            "–"
                          ) : t.ledgerProblem ? (
                            <span>#{t.pr}</span>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Open PR #${t.pr} for ${t.id} in the browser`}
                              onClick={() => void openPr(t.id)}
                              className="inline-flex items-center gap-1 rounded text-sky-400 underline hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              #{t.pr}
                              <ExternalLink className="h-3 w-3" aria-hidden />
                            </button>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <div>{usd(t.costUsd)}</div>
                          {t.judgeCostUsd !== null && (
                            <div className="text-muted-foreground">
                              judge {usd(t.judgeCostUsd)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          {t.buildRounds} build / {t.judgeRounds} judge
                          {t.retryRounds !== null && t.retryRounds > 0
                            ? ` (${t.retryRounds} retry)`
                            : ""}
                        </td>
                        <td className="py-2 pr-2">
                          <div>{t.minutes.toFixed(1)} min</div>
                          {t.cardToPrMinutes !== null && (
                            <div className="text-muted-foreground">
                              {t.cardToPrMinutes.toFixed(1)} min to PR
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {when(t.closedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
