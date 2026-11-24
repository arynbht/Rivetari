import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { when } from "@/lib/time";

import type {
  PostureDraftResult,
  ProjectField,
  ProjectSkill,
  ProjectView,
} from "../../shared/ipc";

// Project: profile.yml held against what the repo shows now, checked again by
// itself (when the repo opens, after a task merges, once a day), with the
// autonomy, proof, skills and banned patterns it records. It writes nothing:
// profile.yml is a protected path, so "Update the profile" drafts a task card
// through the runtime, which the person confirms in Now.

const SKILL_STATE: Record<
  ProjectSkill["state"],
  { label: string; text: string }
> = {
  installed: { label: "Installed", text: "text-emerald-400" },
  "per-task": { label: "Per task", text: "text-muted-foreground" },
  "not-installed": { label: "Not installed", text: "text-amber-300" },
  blocked: { label: "Blocked", text: "text-rose-300" },
  modified: { label: "Modified", text: "text-rose-300" },
};

/** The default proof waits this long for the app to answer (the runner's). */
const DEFAULT_READY_SECONDS = 90;

function FieldRow({
  field,
  picked,
  onToggle,
}: {
  field: ProjectField;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr
      className={`border-t border-border/60 align-top ${
        field.differs ? "bg-amber-500/10" : ""
      }`}
      data-differs={field.differs ? "true" : undefined}
    >
      <td className="py-1.5 pl-2 pr-2">
        {field.differs && (
          <input
            type="checkbox"
            checked={picked}
            onChange={onToggle}
            aria-label={`Include ${field.label} in the update`}
            className="h-3.5 w-3.5 accent-sky-500"
          />
        )}
      </td>
      <th scope="row" className="py-1.5 pr-2 text-left font-medium">
        {field.label}
        {field.differs && (
          <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
            Differs
          </span>
        )}
      </th>
      <td className="py-1.5 pr-2">
        {field.declared ?? (
          <span className="text-muted-foreground">not set</span>
        )}
      </td>
      <td className="py-1.5 pr-2">
        {field.detected ?? (
          <span className="text-muted-foreground">can&apos;t tell</span>
        )}
        {field.change && (
          <span className="block text-muted-foreground">
            Update: {field.change.path} → {field.change.to}
          </span>
        )}
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        {field.evidence ?? ""}
      </td>
    </tr>
  );
}

function Autonomy({
  autonomy,
  unreadable,
}: {
  autonomy: ProjectView["autonomy"];
  /** profile.yml won't load, so the configured level isn't known. */
  unreadable: boolean;
}) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Configured (profile.yml)</dt>
        <dd className="font-medium">
          {unreadable ? "can't be read" : (autonomy.configured ?? "not set")}
        </dd>
        <dt className="text-muted-foreground">Effective level</dt>
        <dd>
          run <code>rivetari autonomy</code> to see it and what the next level
          needs
        </dd>
      </dl>
      {autonomy.problems.map((p) => (
        <p key={p} className="text-xs text-amber-300">
          {p}
        </p>
      ))}
      {autonomy.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No changes recorded in .rivetari/autonomy/ledger.jsonl.
        </p>
      ) : (
        <table
          aria-label="Autonomy history"
          className="w-full text-left text-xs"
        >
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                When
              </th>
              <th scope="col" className="py-1 font-medium">
                Level
              </th>
              <th scope="col" className="py-1 font-medium">
                Change
              </th>
              <th scope="col" className="py-1 font-medium">
                Rules
              </th>
              <th scope="col" className="py-1 font-medium">
                Note
              </th>
              <th scope="col" className="py-1 font-medium">
                By
              </th>
            </tr>
          </thead>
          <tbody>
            {[...autonomy.entries].reverse().map((e) => (
              <tr
                key={`${e.at}-${e.level}-${e.kind}`}
                className="border-t border-border/60 align-top"
              >
                <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums">
                  {when(e.at)}
                </td>
                <td className="py-1.5 pr-2 font-medium">{e.level}</td>
                <td className="py-1.5 pr-2">{e.kind}</td>
                <td className="py-1.5 pr-2 tabular-nums">{e.rules}</td>
                <td className="py-1.5 pr-2">{e.note || "–"}</td>
                <td className="py-1.5">{e.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Proof({
  proof,
  unreadable,
}: {
  proof: ProjectView["proof"];
  unreadable: boolean;
}) {
  if (unreadable)
    return (
      <p className="text-xs text-amber-300">
        profile.yml can&apos;t be read, so its proof settings aren&apos;t known.
      </p>
    );
  if (!proof)
    return (
      <p className="text-xs text-muted-foreground">
        profile.yml has no proof block, so UI proof serves nothing until one is
        set.
      </p>
    );
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Start command</dt>
      <dd>
        {proof.start ? (
          <code>{proof.start}</code>
        ) : (
          <span className="text-muted-foreground">not set</span>
        )}
      </dd>
      <dt className="text-muted-foreground">URL</dt>
      <dd>
        {proof.url ? (
          <code>{proof.url}</code>
        ) : (
          <span className="text-muted-foreground">
            default (http://localhost:{"{port}"})
          </span>
        )}
      </dd>
      <dt className="text-muted-foreground">Ready timeout</dt>
      <dd className="tabular-nums">
        {proof.readyTimeout !== null
          ? `${proof.readyTimeout} s`
          : `default (${DEFAULT_READY_SECONDS} s)`}
      </dd>
      <dt className="text-muted-foreground">Sign-in script</dt>
      <dd>{proof.auth ? "set" : "not set"}</dd>
    </dl>
  );
}

function Skills({ skills }: { skills: ProjectView["skills"] }) {
  const always = skills.locked.filter((s) => s.scope === "always").length;
  return (
    <div className="space-y-3">
      {skills.error && (
        <p className="text-sm text-amber-300" role="alert">
          {skills.error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {skills.locked.length} locked · {skills.installed} of {always} always-on
        installed ·{" "}
        {skills.syncedAt
          ? `synced ${new Date(skills.syncedAt).toLocaleString()}`
          : "never synced"}
      </p>
      {skills.problems.map((p) => (
        <p key={p} className="text-xs text-amber-300">
          {p}
        </p>
      ))}
      {skills.locked.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No skills locked in .rivetari/skills.lock.
        </p>
      ) : (
        <table aria-label="Locked skills" className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Skill
              </th>
              <th scope="col" className="py-1 font-medium">
                Scope
              </th>
              <th scope="col" className="py-1 font-medium">
                State
              </th>
              <th scope="col" className="py-1 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {skills.locked.map((s) => (
              <tr key={s.name} className="border-t border-border/60 align-top">
                <td className="py-1.5 pr-2">
                  <span className="block font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {s.source}@{s.pin.slice(0, 7)}
                  </span>
                </td>
                <td className="py-1.5 pr-2">{s.scope}</td>
                <td
                  className={`py-1.5 pr-2 font-medium ${SKILL_STATE[s.state].text}`}
                >
                  {SKILL_STATE[s.state].label}
                </td>
                <td className="py-1.5 text-muted-foreground">
                  {s.detail ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="space-y-1">
        <h4 id="project-gaps" className="text-sm font-medium">
          Gaps the router hit ({skills.gaps.length})
        </h4>
        {skills.gaps.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No task&apos;s route has found a sector without a skill.
          </p>
        ) : (
          <ul aria-labelledby="project-gaps" className="space-y-1 text-xs">
            {skills.gaps.map((g) => (
              <li
                key={`${g.sector ?? ""}-${g.reason}`}
                className="rounded-md border border-border/60 px-2 py-1.5"
              >
                <span className="font-medium">{g.sector ?? "A sector"}</span>:{" "}
                {g.reason}
                <span className="block text-muted-foreground">
                  Hit by {g.tasks.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Banned({ banned }: { banned: ProjectView["banned"] }) {
  if (banned.error)
    return (
      <p className="text-sm text-amber-300" role="alert">
        {banned.error}
      </p>
    );
  if (banned.patterns.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No banned patterns in .rivetari/banned.json.
      </p>
    );
  return (
    <table aria-label="Banned patterns" className="w-full text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="py-1 font-medium">
            Pattern
          </th>
          <th scope="col" className="py-1 font-medium">
            Files
          </th>
          <th scope="col" className="py-1 font-medium">
            Why
          </th>
          <th scope="col" className="py-1 font-medium">
            Source
          </th>
        </tr>
      </thead>
      <tbody>
        {banned.patterns.map((p) => (
          <tr key={p.id} className="border-t border-border/60 align-top">
            <td className="py-1.5 pr-2">
              <span className="block font-medium">{p.id}</span>
              <code className="break-all text-muted-foreground">
                {p.pattern}
              </code>
            </td>
            <td className="py-1.5 pr-2">
              <code>{p.files}</code>
            </td>
            <td className="py-1.5 pr-2">{p.why}</td>
            <td className="py-1.5 text-muted-foreground">{p.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Project({
  repoPath,
  onOpenTask,
}: {
  repoPath: string;
  onOpenTask: (id: string) => void;
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Every row that differs is in the update unless the person leaves it out.
  const [left, setLeft] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState<PostureDraftResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Counts reads, so only the latest one (a Refresh, a push, the first read) lands.
  const loadSeq = useRef(0);

  // A row left out that no longer differs is forgotten, so it's back in if it
  // differs again.
  const show = useCallback((next: ProjectView) => {
    setView(next);
    const differ = new Set(
      next.fields.filter((f) => f.differs).map((f) => f.key),
    );
    setLeft((prev) => new Set([...prev].filter((key) => differ.has(key))));
  }, []);

  const load = useCallback(
    (force: boolean) => {
      const seq = ++loadSeq.current;
      const active = () => seq === loadSeq.current;
      setLoading(true);
      const read = force
        ? window.rivetari.project.refresh(repoPath)
        : window.rivetari.project.get(repoPath);
      read.then(
        (next) => {
          if (!active()) return;
          show(next);
          setError(null);
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
    },
    [repoPath, show],
  );

  useEffect(() => {
    const cancel = load(false);
    // A check main ran by itself (repo opened, a task merged, a day passed)
    // is newer than any read in flight.
    const off = window.rivetari.project.onUpdate((next) => {
      if (next.repoPath !== repoPath) return;
      loadSeq.current++;
      show(next);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancel();
      off();
    };
  }, [repoPath, load, show]);

  async function draft(): Promise<void> {
    setBusy(true);
    setDraftError(null);
    setDrafted(null);
    try {
      setDrafted(
        await window.rivetari.project.draft(
          repoPath,
          chosen.map((f) => f.key),
        ),
      );
    } catch (err) {
      setDraftError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: string): void {
    setLeft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const differing = view?.fields.filter((f) => f.differs) ?? [];
  const chosen = differing.filter((f) => !left.has(f.key));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Project</h2>
          <p className="text-xs text-muted-foreground">
            {view
              ? `Checked ${new Date(view.checkedAt).toLocaleString()}. Checked again when the repo opens, after a task merges, and once a day.`
              : "What .rivetari/profile.yml says beside what the repo shows now."}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => load(true)}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

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

      {!view ? (
        loading && (
          <p className="text-sm text-muted-foreground">Checking the repo…</p>
        )
      ) : (
        <>
          {view.profileError && (
            <p className="text-sm text-amber-300" role="alert">
              {view.profileError}
            </p>
          )}
          {view.problems.map((p) => (
            <p key={p} className="text-sm text-amber-300">
              {p}
            </p>
          ))}

          <section aria-labelledby="project-profile" className="space-y-2">
            <h3 id="project-profile" className="text-sm font-semibold">
              Profile against the repo
            </h3>
            <p className="text-xs text-muted-foreground">
              {differing.length === 0
                ? "Every field Rivetari can read from the repo matches profile.yml."
                : `${differing.length} ${differing.length === 1 ? "field differs" : "fields differ"} from what the repo shows.`}
            </p>
            <table
              aria-label="Profile against the repo"
              className="w-full text-left text-xs"
            >
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="w-8 py-1 pl-2">
                    <span className="sr-only">Include</span>
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    profile.yml
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    The repo now
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.fields.map((f) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    picked={!left.has(f.key)}
                    onToggle={() => toggle(f.key)}
                  />
                ))}
              </tbody>
            </table>
            {view.otherFlags.length > 0 && (
              <p className="text-xs text-muted-foreground">
                profile.yml also sets {view.otherFlags.join(", ")}, which no
                file can show; a person keeps those current.
              </p>
            )}
            {view.openTask && (
              <p className="text-xs text-sky-300">
                {view.openTask.id} already changes profile.yml:{" "}
                {view.openTask.title}.
              </p>
            )}
            {view.profileFound && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  disabled={busy || chosen.length === 0}
                  onClick={() => void draft()}
                  aria-describedby="project-update-note"
                >
                  Update the profile
                </Button>
                <span
                  id="project-update-note"
                  className="text-xs text-muted-foreground"
                >
                  {differing.length === 0
                    ? "Nothing to update."
                    : `Drafts one task for ${chosen.length} of ${differing.length}: profile.yml is a protected path, so it changes through a reviewed PR.`}
                </span>
              </div>
            )}
          </section>

          <section aria-labelledby="project-autonomy" className="space-y-2">
            <h3 id="project-autonomy" className="text-sm font-semibold">
              Autonomy
            </h3>
            <Autonomy
              autonomy={view.autonomy}
              unreadable={view.profileError !== null}
            />
          </section>

          <section aria-labelledby="project-proof" className="space-y-2">
            <h3 id="project-proof" className="text-sm font-semibold">
              Proof
            </h3>
            <Proof proof={view.proof} unreadable={view.profileError !== null} />
          </section>

          <section aria-labelledby="project-skills" className="space-y-2">
            <h3 id="project-skills" className="text-sm font-semibold">
              Skills
            </h3>
            <Skills skills={view.skills} />
          </section>

          <section aria-labelledby="project-banned" className="space-y-2">
            <h3 id="project-banned" className="text-sm font-semibold">
              Banned patterns
            </h3>
            <p className="text-xs text-muted-foreground">
              What the judge refuses in a diff, from .rivetari/banned.json.
            </p>
            <Banned banned={view.banned} />
          </section>
        </>
      )}
    </div>
  );
}
