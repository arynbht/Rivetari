import { ChevronDown, ChevronRight, Play, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { STATUS_META } from "@/lib/status";

import type {
  ExpiryState,
  GateStatus,
  Posture as PostureData,
  PostureDraft,
  PostureDraftResult,
  PostureLens,
  PostureTrendPoint,
  ScorecardControl,
  ScorecardLane,
  StatusCounts,
} from "../../shared/ipc";

// Posture: the scorecard and the phase lens over the one audit state.json
// records, a trend from history.jsonl, and the waivers and evidence on file.
// It changes nothing itself. Fixing gaps, waiving and attaching evidence each
// draft a task card through the runtime, which the person confirms in Now.
// Run audit records a fresh audit the way `rivetari audit` does and costs
// nothing; the deep audit costs money, so it has its own button and asks first.

const GATE_DOT: Record<GateStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
};

const GATE_WORD: Record<GateStatus, string> = {
  green: "green",
  amber: "amber",
  red: "red",
};

const EXPIRY: Record<ExpiryState, { label: string; text: string }> = {
  active: { label: "Active", text: "text-muted-foreground" },
  expiring: { label: "Expires soon", text: "text-amber-400" },
  expired: { label: "Expired", text: "text-rose-400" },
};

const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The most controls one gaps card takes (PostureDraft's limit). */
const MAX_GAPS = 30;

const failing = (c: ScorecardControl) =>
  c.status === "fail" || c.status === "needs-evidence";

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function in90Days(): string {
  return new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
}

/** The recorded totals, labelled so they read without the colours. */
function Totals({ counts }: { counts: StatusCounts & { total: number } }) {
  const items: [string, number, string][] = [
    ["Pass", counts.pass, STATUS_META.pass.text],
    ["Fail", counts.fail, STATUS_META.fail.text],
    [
      "Needs evidence",
      counts.needsEvidence,
      STATUS_META["needs-evidence"].text,
    ],
    ["Waived", counts.waived, STATUS_META.waived.text],
    ["Skipped", counts.skip, STATUS_META.skip.text],
    ["N/A", counts.na, STATUS_META["n/a"].text],
    ["Total", counts.total, "text-foreground"],
  ];
  return (
    <dl
      aria-label="Recorded totals"
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums"
    >
      {items.map(([label, n, text]) => (
        <div key={label} className="flex gap-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={`font-medium ${text}`}>{n}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Trend ────────────────────────────────────────────────────────────────

const SERIES = [
  {
    key: "pass",
    label: "Pass",
    stroke: "stroke-emerald-500",
    swatch: "bg-emerald-500",
  },
  {
    key: "fail",
    label: "Fail",
    stroke: "stroke-rose-500",
    swatch: "bg-rose-500",
  },
  {
    key: "needsEvidence",
    label: "Needs evidence",
    stroke: "stroke-amber-500",
    swatch: "bg-amber-500",
  },
] as const;

const W = 600;
const H = 150;
const PAD = { top: 10, right: 12, bottom: 22, left: 34 };

/** The SVG path for one series, broken wherever a snapshot lacks the value. */
function seriesPath(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function readout(p: PostureTrendPoint): string {
  const parts = [`${p.pass} pass`];
  if (p.fail !== null) parts.push(`${p.fail} fail`);
  if (p.needsEvidence !== null) parts.push(`${p.needsEvidence} needs evidence`);
  return `${p.date}: ${parts.join(", ")} of ${p.total}`;
}

function Trend({ points }: { points: PostureTrendPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();

  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No posture snapshots yet. CI appends one to .rivetari/history.jsonl on
        every run.
      </p>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.total));
  const span = W - PAD.left - PAD.right;
  const x = (i: number) =>
    PAD.left +
    (points.length === 1 ? span / 2 : (i * span) / (points.length - 1));
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / max);
  const shown = points[active ?? points.length - 1];
  const last = points[points.length - 1];
  const partial = points.some((p) => p.fail === null);
  const step = points.length > 1 ? span / (points.length - 1) : span;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul
          aria-label="Trend legend"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {SERIES.map((s) => {
            const value = last?.[s.key];
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <span
                  className={`h-0.5 w-3 rounded-full ${s.swatch}`}
                  aria-hidden
                />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="font-medium tabular-nums">
                  {value === null || value === undefined ? "–" : value}
                </span>
              </li>
            );
          })}
          <li className="flex items-center gap-1.5">
            <span
              className="h-0 w-3 border-t border-dashed border-muted-foreground"
              aria-hidden
            />
            <span className="text-muted-foreground">Total</span>
            <span className="font-medium tabular-nums">{last?.total}</span>
          </li>
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
          <caption className="sr-only">Posture snapshots, oldest first</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Date
              </th>
              <th scope="col" className="py-1 font-medium">
                Pass
              </th>
              <th scope="col" className="py-1 font-medium">
                Fail
              </th>
              <th scope="col" className="py-1 font-medium">
                Needs evidence
              </th>
              <th scope="col" className="py-1 font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={`${p.date}-${i}`} className="border-t border-border/60">
                <td className="py-1">{p.date}</td>
                <td className="py-1">{p.pass}</td>
                <td className="py-1">{p.fail ?? "–"}</td>
                <td className="py-1">{p.needsEvidence ?? "–"}</td>
                <td className="py-1">{p.total}</td>
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
              {`Posture trend over ${points.length} snapshots, from ${points[0]?.date} to ${last?.date}. Latest: ${last ? readout(last) : ""}.`}
            </title>
            {/* Recessive grid: the baseline and the top of the scale. */}
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
                  {v}
                </text>
              </g>
            ))}
            <text
              x={x(0)}
              y={H - 6}
              textAnchor={points.length === 1 ? "middle" : "start"}
              className="fill-muted-foreground text-[10px]"
            >
              {points[0]?.date}
            </text>
            {points.length > 1 && (
              <text
                x={x(points.length - 1)}
                y={H - 6}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {last?.date}
              </text>
            )}
            <path
              d={seriesPath(
                points.map((p) => p.total),
                x,
                y,
              )}
              fill="none"
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {SERIES.map((s) => (
              <path
                key={s.key}
                d={seriesPath(
                  points.map((p) => p[s.key]),
                  x,
                  y,
                )}
                fill="none"
                className={s.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {active !== null && (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                className="stroke-muted-foreground"
                strokeWidth={1}
              />
            )}
            {SERIES.map((s) => {
              const i = active ?? points.length - 1;
              const v = points[i]?.[s.key];
              if (v === null || v === undefined) return null;
              return (
                <circle
                  key={s.key}
                  cx={x(i)}
                  cy={y(v)}
                  r={4}
                  className={`${s.stroke} fill-background`}
                  strokeWidth={2}
                />
              );
            })}
            {/* Hover columns wider than the marks, one per snapshot. */}
            {points.map((p, i) => (
              <rect
                key={`${p.date}-${i}`}
                x={x(i) - step / 2}
                y={0}
                width={Math.max(step, 8)}
                height={H}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              />
            ))}
          </svg>
          <p className="text-xs tabular-nums text-muted-foreground">
            {shown ? readout(shown) : ""}
          </p>
        </>
      )}
      {partial && (
        <p className="text-xs text-muted-foreground">
          Older snapshots record only passing controls of the total (waived
          counted as passing), so fail and needs evidence start where CI began
          recording them.
        </p>
      )}
    </div>
  );
}

// ── Phase lens ──────────────────────────────────────────────────────────

function Lens({
  lens,
  onSelect,
}: {
  lens: PostureLens;
  onSelect: (ids: string[]) => void;
}) {
  const title = (key: string | null) =>
    lens.phases.find((p) => p.phase === key)?.title ?? key ?? "none";
  const current = lens.declaredPhase ?? lens.inferredPhase;
  const moved =
    lens.declaredPhase !== null &&
    lens.inferredPhase !== null &&
    lens.declaredPhase !== lens.inferredPhase;

  return (
    <div className="space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-muted-foreground">
            Current phase (profile.yml)
          </dt>
          <dd className="mt-0.5 font-medium">
            {lens.declaredPhase ? title(lens.declaredPhase) : "Not declared"}
          </dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-muted-foreground">
            Where the controls put it
          </dt>
          <dd className="mt-0.5 font-medium">
            {lens.inferredPhase ? title(lens.inferredPhase) : "No gate defined"}
          </dd>
        </div>
      </dl>

      <ol aria-label="Phase gates" className="flex flex-wrap gap-x-3 gap-y-1">
        {lens.phases.map((p) => (
          <li
            key={p.phase}
            className={`flex items-center gap-1.5 text-xs ${
              p.phase === lens.inferredPhase
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                p.status ? GATE_DOT[p.status] : "border border-border"
              }`}
              aria-hidden
            />
            {p.title}
            <span className="sr-only">
              : gate {p.status ? GATE_WORD[p.status] : "not defined"}
              {p.phase === lens.declaredPhase ? ", current phase" : ""}
              {p.phase === lens.inferredPhase
                ? ", where the controls put it"
                : ""}
            </span>
          </li>
        ))}
      </ol>

      {lens.allGreen ? (
        <p className="text-sm text-emerald-400">Every defined gate is green.</p>
      ) : lens.inferredPhase ? (
        <div className="space-y-2">
          {moved && (
            <p className="text-sm text-muted-foreground">
              {/* The declared gate passed, or selects nothing for this repo. */}
              The {title(lens.declaredPhase)} gate{" "}
              {lens.phases.find((p) => p.phase === lens.declaredPhase)
                ?.status === "green"
                ? "is green"
                : "isn't defined for this repo"}
              , so the controls put the repo at {title(lens.inferredPhase)}.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium" id="posture-next">
              Between {title(moved ? lens.inferredPhase : current)} and{" "}
              {lens.nextPhase ? title(lens.nextPhase) : "the end"}:{" "}
              {lens.blockers.length}{" "}
              {lens.blockers.length === 1 ? "control" : "controls"}
            </h4>
            {lens.blockers.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSelect(lens.blockers.map((b) => b.controlId))}
              >
                Select these for a task
              </Button>
            )}
          </div>
          <ul aria-labelledby="posture-next" className="space-y-1">
            {lens.blockers.map((b) => (
              <li key={b.controlId} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_META[b.status].dot}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="font-medium">{b.title}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {b.controlId} · {b.severity} ·{" "}
                    <span className={STATUS_META[b.status].text}>
                      {STATUS_META[b.status].label}
                    </span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No gate selects a recorded control, so there&apos;s no phase to infer.
        </p>
      )}
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────

type FormKind = "waive" | "evidence";

function DraftForm({
  control,
  kind,
  busy,
  onDraft,
  onCancel,
}: {
  control: ScorecardControl;
  kind: FormKind;
  busy: boolean;
  onDraft: (draft: PostureDraft) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState(in90Days());
  const [url, setUrl] = useState("");
  const id = useId();
  const label =
    kind === "waive"
      ? `Start a task to waive ${control.controlId}`
      : `Start a task to attach evidence for ${control.controlId}`;

  return (
    <form
      aria-label={label}
      className="mt-2 space-y-2 rounded-md bg-background/50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (kind === "waive")
          onDraft({
            kind,
            control: control.controlId,
            reason: reason.trim(),
            expires,
          });
        else
          onDraft({
            kind,
            control: control.controlId,
            reason: reason.trim(),
            ...(url.trim() ? { url: url.trim() } : {}),
          });
      }}
    >
      <p className="text-xs text-muted-foreground">
        {kind === "waive"
          ? "This drafts a task card that adds the waiver to .rivetari/waivers.yml through a reviewed PR. Nothing changes in this checkout now."
          : "This drafts a task card that records the evidence in .rivetari/evidence.yml through a reviewed PR. Nothing changes in this checkout now."}
      </p>
      <label htmlFor={`${id}-reason`} className="block text-xs">
        {kind === "waive"
          ? "Why it should be waived"
          : "What the evidence shows"}
      </label>
      <input
        id={`${id}-reason`}
        className={inputClass}
        value={reason}
        required
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      {kind === "waive" ? (
        <>
          <label htmlFor={`${id}-expires`} className="block text-xs">
            Waive until
          </label>
          <input
            id={`${id}-expires`}
            type="date"
            className={inputClass}
            min={tomorrow()}
            value={expires}
            required
            onChange={(e) => setExpires(e.target.value)}
          />
        </>
      ) : (
        <>
          <label htmlFor={`${id}-url`} className="block text-xs">
            Link (optional)
          </label>
          <input
            id={`${id}-url`}
            type="url"
            className={inputClass}
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        </>
      )}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || !reason.trim()}>
          {kind === "waive"
            ? "Start a task to waive"
            : "Start a task to attach evidence"}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ControlRow({
  control,
  selected,
  onToggle,
  form,
  onForm,
  busy,
  onDraft,
}: {
  control: ScorecardControl;
  selected: boolean;
  onToggle: () => void;
  form: FormKind | null;
  onForm: (kind: FormKind | null) => void;
  busy: boolean;
  onDraft: (draft: PostureDraft) => void;
}) {
  const meta = STATUS_META[control.status];
  const gap = failing(control);
  return (
    <li className="border-t border-border/60 px-4 py-2">
      <div className="flex items-center gap-3">
        {gap ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${control.controlId}`}
            className="h-4 w-4 shrink-0 accent-sky-500"
          />
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {control.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {control.controlId} · {control.severity}
          </span>
        </span>
        <span className={`shrink-0 text-xs ${meta.text}`}>{meta.label}</span>
        {gap && (
          <span className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="outline"
              aria-expanded={form === "waive"}
              aria-label={`Waive ${control.controlId}`}
              onClick={() => onForm(form === "waive" ? null : "waive")}
            >
              Waive…
            </Button>
            {control.status === "needs-evidence" && (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={form === "evidence"}
                aria-label={`Attach evidence for ${control.controlId}`}
                onClick={() => onForm(form === "evidence" ? null : "evidence")}
              >
                Evidence…
              </Button>
            )}
          </span>
        )}
      </div>
      {form && (
        <DraftForm
          control={control}
          kind={form}
          busy={busy}
          onDraft={onDraft}
          onCancel={() => onForm(null)}
        />
      )}
    </li>
  );
}

function LaneCard({
  lane,
  children,
}: {
  lane: ScorecardLane;
  children: React.ReactNode;
}) {
  const gaps = lane.counts.fail + lane.counts.needsEvidence;
  const [open, setOpen] = useState(gaps > 0);
  return (
    <Card>
      <h4>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 p-3 text-left text-sm"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 font-medium">{lane.title}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {lane.counts.pass} pass
            {lane.counts.fail > 0 && ` · ${lane.counts.fail} fail`}
            {lane.counts.needsEvidence > 0 &&
              ` · ${lane.counts.needsEvidence} need evidence`}
            {lane.counts.waived > 0 && ` · ${lane.counts.waived} waived`}
          </span>
        </button>
      </h4>
      {open && <ul>{children}</ul>}
    </Card>
  );
}

// ── Waivers and evidence ────────────────────────────────────────────────

function ExpiryBadge({ state }: { state: ExpiryState }) {
  return (
    <span className={`text-xs font-medium ${EXPIRY[state].text}`}>
      {EXPIRY[state].label}
    </span>
  );
}

function Waivers({ posture }: { posture: PostureData }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium" id="posture-waivers">
          Waivers ({posture.waivers.length})
        </h4>
        {posture.waivers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No waivers in .rivetari/waivers.yml.
          </p>
        ) : (
          <table
            aria-labelledby="posture-waivers"
            className="w-full text-left text-xs"
          >
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Control
                </th>
                <th scope="col" className="py-1 font-medium">
                  Reason
                </th>
                <th scope="col" className="py-1 font-medium">
                  Owner
                </th>
                <th scope="col" className="py-1 font-medium">
                  Added
                </th>
                <th scope="col" className="py-1 font-medium">
                  Expires
                </th>
                <th scope="col" className="py-1 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {posture.waivers.map((w, i) => (
                <tr
                  key={`${w.control}-${i}`}
                  className="border-t border-border/60 align-top"
                >
                  <td className="py-1.5 pr-2">
                    <span className="block font-medium">{w.title}</span>
                    <span className="text-muted-foreground">{w.control}</span>
                  </td>
                  <td className="py-1.5 pr-2">{w.reason}</td>
                  <td className="py-1.5 pr-2">{w.owner ?? "–"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums">
                    {w.created ?? "–"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums">
                    {w.expires}
                  </td>
                  <td className="py-1.5">
                    <ExpiryBadge state={w.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium" id="posture-evidence">
          Evidence ({posture.evidence.length})
        </h4>
        {posture.evidence.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No evidence in .rivetari/evidence.yml.
          </p>
        ) : (
          <table
            aria-labelledby="posture-evidence"
            className="w-full text-left text-xs"
          >
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Control
                </th>
                <th scope="col" className="py-1 font-medium">
                  Note
                </th>
                <th scope="col" className="py-1 font-medium">
                  Reviewer
                </th>
                <th scope="col" className="py-1 font-medium">
                  Dated
                </th>
                <th scope="col" className="py-1 font-medium">
                  Expires
                </th>
                <th scope="col" className="py-1 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {posture.evidence.map((e, i) => (
                <tr
                  key={`${e.control}-${i}`}
                  className="border-t border-border/60 align-top"
                >
                  <td className="py-1.5 pr-2">
                    <span className="block font-medium">{e.title}</span>
                    <span className="text-muted-foreground">{e.control}</span>
                  </td>
                  <td className="py-1.5 pr-2">
                    {e.note ?? "–"}
                    {e.url && (
                      <span className="block break-all text-muted-foreground">
                        {e.url}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">{e.reviewer ?? "–"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums">
                    {e.date ?? "–"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums">
                    {e.expires ?? "Never"}
                  </td>
                  <td className="py-1.5">
                    <ExpiryBadge state={e.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── The view ────────────────────────────────────────────────────────────

export function Posture({
  repoPath,
  deepAuditRunning,
  deepAuditError,
  onDeepAudit,
  onOpenTask,
}: {
  repoPath: string;
  /** True while a deep audit started from here is running. */
  deepAuditRunning: boolean;
  deepAuditError: string | null;
  /** Start the deep audit, once the person has confirmed its cost. */
  onDeepAudit: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [posture, setPosture] = useState<PostureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [form, setForm] = useState<{ control: string; kind: FormKind } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState<PostureDraftResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deepAvailable, setDeepAvailable] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Counts reads, so only the latest one (a Reload, or the first read) lands.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const active = () => seq === loadSeq.current;
    setLoading(true);
    window.rivetari.posture.get(repoPath).then(
      (next) => {
        if (!active()) return;
        setPosture(next);
        setError(null);
        // A control that passes now can't stay picked for a gaps card.
        const gaps = new Set(
          (next.scorecard?.lanes ?? [])
            .flatMap((l) => l.controls)
            .filter(failing)
            .map((c) => c.controlId),
        );
        setSelected((prev) => new Set([...prev].filter((id) => gaps.has(id))));
        setLoading(false);
      },
      (err: unknown) => {
        if (!active()) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      if (active()) loadSeq.current++;
    };
  }, [repoPath]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    let active = true;
    window.rivetari.floorplan.get(repoPath).then(
      (view) => active && setDeepAvailable(view.deepAuditAvailable),
      () => {
        // Unknown availability leaves the button on; running it reports why.
      },
    );
    return () => {
      active = false;
    };
  }, [repoPath]);

  const gapIds = useMemo(
    () =>
      new Set(
        (posture?.scorecard?.lanes ?? [])
          .flatMap((l) => l.controls)
          .filter(failing)
          .map((c) => c.controlId),
      ),
    [posture],
  );

  /** Record a fresh audit in state.json, then read the record again. */
  async function runAudit(): Promise<void> {
    setAuditing(true);
    setAuditError(null);
    try {
      await window.rivetari.audit.run(repoPath);
      load();
    } catch (err) {
      setAuditError(errorMessage(err));
    } finally {
      setAuditing(false);
    }
  }

  async function draft(next: PostureDraft): Promise<void> {
    setBusy(true);
    setDraftError(null);
    setDrafted(null);
    try {
      const result = await window.rivetari.posture.draft(repoPath, next);
      setDrafted(result);
      setForm(null);
      if (next.kind === "gaps") setSelected(new Set());
    } catch (err) {
      setDraftError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const scorecard = posture?.scorecard ?? null;
  const picked = [...selected].filter((id) => gapIds.has(id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Posture</h2>
          <p className="text-xs text-muted-foreground">
            {scorecard
              ? `${scorecard.totals.total} controls · recorded ${
                  scorecard.generatedAt
                    ? new Date(scorecard.generatedAt).toLocaleString()
                    : "at an unknown time"
                } in .rivetari/state.json`
              : "The audit recorded in .rivetari/state.json, the phase it puts the repo in, and the waivers and evidence on file."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Reload
          </Button>
          <Button onClick={() => void runAudit()} disabled={auditing}>
            {auditing ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {auditing ? "Auditing…" : "Run audit"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirming(true)}
            disabled={deepAuditRunning || !deepAvailable || confirming}
            aria-describedby="posture-deep-cost"
          >
            {deepAuditRunning ? "Deep audit running…" : "Deep audit"}
          </Button>
        </div>
      </div>
      <p id="posture-deep-cost" className="-mt-4 text-xs text-muted-foreground">
        The deep audit runs Claude agents over the repository and costs money.
        You&apos;ll be asked before it starts.
      </p>

      {confirming && (
        <div
          role="group"
          aria-labelledby="posture-deep-title"
          className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p id="posture-deep-title" className="text-sm font-medium">
            Run the deep audit?
          </p>
          <p className="text-sm text-muted-foreground">
            It starts a swarm of Claude agents, one for each part of the
            repository (up to 12), to rebuild the floor plan on the Map tab. It
            uses Claude and costs money: it runs on your Claude Code
            subscription and counts against its usage. There&apos;s no cost
            estimate for it yet.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                onDeepAudit();
              }}
            >
              Run the deep audit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!deepAvailable && (
        <p className="text-xs text-amber-300">
          Deep audit needs the Claude Code CLI. Sign in with{" "}
          <code>claude login</code> so the swarm can run on your subscription.
        </p>
      )}
      {deepAuditError && (
        <p className="text-sm text-rose-400" role="alert">
          {deepAuditError}
        </p>
      )}
      {auditError && (
        <p className="text-sm text-rose-400" role="alert">
          {auditError}
        </p>
      )}

      <div role="status" aria-live="polite" className="empty:hidden">
        {drafted && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
            <span>
              Drafted {drafted.id}: {drafted.title}. It waits at intake for a
              person to confirm it in Now.
              {drafted.warning && (
                <span className="block text-xs text-amber-300">
                  {drafted.warning}
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenTask(drafted.id)}
            >
              Open {drafted.id} in Tasks
            </Button>
          </div>
        )}
      </div>
      {draftError && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {draftError}
        </p>
      )}
      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {error}
        </p>
      )}
      {posture?.problems.map((p) => (
        <p key={p} className="text-sm text-amber-300">
          {p}
        </p>
      ))}

      {!posture ? (
        loading && (
          <p className="text-sm text-muted-foreground">Reading the record…</p>
        )
      ) : (
        <>
          {!scorecard && (
            <p className="text-sm text-muted-foreground">
              No audit has been recorded for this repository yet
              (.rivetari/state.json is missing). <code>rivetari audit</code>{" "}
              records one, as does Run audit above.
            </p>
          )}

          {scorecard && posture.lens && (
            <section aria-labelledby="posture-phase" className="space-y-2">
              <h3 id="posture-phase" className="text-sm font-semibold">
                Phase
              </h3>
              <Lens
                lens={posture.lens}
                onSelect={(ids) =>
                  setSelected((prev) => new Set([...prev, ...ids]))
                }
              />
            </section>
          )}

          <section aria-labelledby="posture-trend" className="space-y-2">
            <h3 id="posture-trend" className="text-sm font-semibold">
              Trend
            </h3>
            <Trend points={posture.trend} />
          </section>

          {scorecard && (
            <section aria-labelledby="posture-controls" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="posture-controls" className="text-sm font-semibold">
                  Controls
                </h3>
                <Totals counts={scorecard.totals} />
              </div>
              <div className="space-y-2">
                {scorecard.lanes.map((lane) => (
                  <LaneCard key={lane.key} lane={lane}>
                    {lane.controls.map((c) => (
                      <ControlRow
                        key={c.controlId}
                        control={c}
                        selected={selected.has(c.controlId)}
                        onToggle={() => toggle(c.controlId)}
                        form={form?.control === c.controlId ? form.kind : null}
                        onForm={(kind) =>
                          setForm(kind ? { control: c.controlId, kind } : null)
                        }
                        busy={busy}
                        onDraft={(d) => void draft(d)}
                      />
                    ))}
                  </LaneCard>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="posture-on-file" className="space-y-2">
            <h3 id="posture-on-file" className="text-sm font-semibold">
              Waivers and evidence
            </h3>
            <p className="text-xs text-muted-foreground">
              Adding either goes through a task: use Waive… or Evidence… on a
              control above.
            </p>
            <Waivers posture={posture} />
          </section>
        </>
      )}

      {scorecard && (
        <div
          className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
          aria-label="Selected gaps"
          role="region"
        >
          <span className="text-sm">
            {picked.length === 0
              ? "Select failing controls to start one task for them."
              : picked.length > MAX_GAPS
                ? `${picked.length} selected; one task takes at most ${MAX_GAPS}.`
                : `${picked.length} selected: ${picked.join(", ")}`}
          </span>
          <span className="flex gap-2">
            {picked.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            )}
            <Button
              size="sm"
              disabled={busy || picked.length === 0 || picked.length > MAX_GAPS}
              onClick={() => void draft({ kind: "gaps", controls: picked })}
            >
              Start a task for these gaps
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
