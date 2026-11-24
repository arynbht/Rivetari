import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

import { KIND_LABEL } from "@/components/Now";
import { isHttps } from "@/components/Tasks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";

import type { HomeRepo, HomeView, NowCi, RepoEntry } from "../../shared/ipc";

// Home: the landing view before a repo is picked, one card per registered
// repo. Each says what's running, what needs the owner, main's CI, spend this
// week, the posture gate and the configured autonomy level, all read by main
// from the records the per-repo views read. Running and Needs you follow the
// Now watchers as they change; CI is asked for per repo and never holds the
// rest up. Nothing here acts: opening a repo is where things get done.

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The first few things a repo waits on; its Now view has the rest. */
const NEEDS_SHOWN = 3;

function ciClass(state: NowCi["state"]): string {
  if (state === "failing") return "text-rose-300";
  if (state === "passing") return "text-emerald-400";
  if (state === "running") return "text-sky-400";
  return "text-muted-foreground";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="font-medium">{label}</dt>
      <dd className="space-y-0.5">{children}</dd>
    </div>
  );
}

/** What stands before the next phase, as Posture's lens says it. */
function gateLine(phase: NonNullable<HomeRepo["phase"]>): string {
  if (phase.allGreen)
    return phase.nextPhase
      ? `its gate is green: ready for ${phase.nextPhase}`
      : "every gate is green";
  const controls = `${phase.blockers} ${phase.blockers === 1 ? "control" : "controls"}`;
  return phase.nextPhase
    ? `${controls} between ${phase.inferred ?? "here"} and ${phase.nextPhase}`
    : `${controls} ${phase.blockers === 1 ? "holds" : "hold"} its gate shut`;
}

function PhaseFact({ repo }: { repo: HomeRepo }) {
  const phase = repo.phase;
  if (!phase)
    return <p className="text-muted-foreground">{repo.phaseNote ?? "–"}</p>;
  const differs =
    phase.declared !== null &&
    phase.inferred !== null &&
    phase.declared !== phase.inferred;
  return (
    <>
      <p>
        declared {phase.declared ?? "none"} · inferred{" "}
        <span className={differs ? "font-medium text-amber-300" : undefined}>
          {phase.inferred ?? "none"}
        </span>
      </p>
      <p className="text-muted-foreground">{gateLine(phase)}</p>
    </>
  );
}

function RepoCard({
  repo,
  ci,
  onOpen,
}: {
  repo: HomeRepo;
  ci: NowCi | undefined;
  onOpen: () => void;
}) {
  const titleId = useId();
  return (
    <Card className="space-y-3 p-4" role="article" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="truncate text-sm font-semibold">
            {repo.name}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {repo.repoPath}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open {repo.name}
        </Button>
      </div>

      {repo.error && (
        <p className="text-xs text-rose-300" role="alert">
          {repo.error}
        </p>
      )}

      <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Running">
          {!repo.ready ? (
            <p className="text-muted-foreground">Reading…</p>
          ) : repo.running.length === 0 ? (
            <p className="text-muted-foreground">nothing running</p>
          ) : (
            <ul>
              {repo.running.map((r) => (
                <li key={r.id}>
                  {r.id} · {r.beat}
                  <span className="text-muted-foreground"> · {r.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label="Needs you">
          {!repo.ready ? (
            <p className="text-muted-foreground">Reading…</p>
          ) : repo.needsYou.length === 0 ? (
            <p className="text-muted-foreground">nothing waiting</p>
          ) : (
            <>
              <ul>
                {repo.needsYou.slice(0, NEEDS_SHOWN).map((n) => (
                  <li key={`${n.id}#${n.kind}`} className="text-amber-300">
                    {KIND_LABEL[n.kind]}: {n.id}
                    <span className="text-muted-foreground"> · {n.why}</span>
                  </li>
                ))}
              </ul>
              {repo.needsYou.length > NEEDS_SHOWN && (
                <p className="text-muted-foreground">
                  and {repo.needsYou.length - NEEDS_SHOWN} more
                </p>
              )}
            </>
          )}
        </Fact>
        <Fact label="main's CI">
          {ci ? (
            <p className={ciClass(ci.state)}>
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
        </Fact>
        <Fact label="Spend this week">
          <p>{usd(repo.spend.weekUsd)} closed in the last 7 days</p>
          <p className="text-muted-foreground">
            {usd(repo.spend.openUsd)} on open tasks
          </p>
          {repo.spend.error && (
            <p className="text-rose-300">{repo.spend.error}</p>
          )}
        </Fact>
        <Fact label="Posture gate">
          <PhaseFact repo={repo} />
        </Fact>
        <Fact label="Autonomy">
          {repo.autonomy.error ? (
            <p className="text-rose-300">{repo.autonomy.error}</p>
          ) : repo.autonomy.configured === null ? (
            <p className="text-muted-foreground">
              no profile to read a level from
            </p>
          ) : (
            <p>
              {repo.autonomy.configured}{" "}
              <span className="text-muted-foreground">(configured)</span>
            </p>
          )}
        </Fact>
      </dl>
    </Card>
  );
}

export function Home({
  repos,
  onOpenRepo,
}: {
  /** The sidebar's list: Home reads again when it changes. */
  repos: RepoEntry[];
  onOpenRepo: (repoPath: string) => void;
}) {
  const [view, setView] = useState<HomeView | null>(null);
  const [ci, setCi] = useState<Record<string, NowCi>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listKey = repos.map((r) => r.path).join("\n");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.rivetari.home.get();
      setView(next);
      // CI reads GitHub; each repo's lands on its own and holds nothing up.
      setCi({});
      for (const repo of next.repos)
        window.rivetari.now.ci(repo.repoPath).then(
          (c) => setCi((prev) => ({ ...prev, [repo.repoPath]: c })),
          (err: unknown) =>
            setCi((prev) => ({
              ...prev,
              [repo.repoPath]: {
                state: "unavailable",
                branch: null,
                url: null,
                detail: errorMessage(err),
              },
            })),
        );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, listKey]);

  // Running and Needs you follow the watchers between reads.
  useEffect(() => {
    return window.rivetari.now.onUpdate((state) =>
      setView((prev) =>
        prev
          ? {
              repos: prev.repos.map((r) =>
                r.repoPath === state.repoPath
                  ? {
                      ...r,
                      ready: state.ready,
                      error: state.error,
                      running: state.running,
                      needsYou: state.needsYou.map((n) => ({
                        id: n.id,
                        title: n.title,
                        kind: n.kind,
                        why: n.why,
                      })),
                      spend: { ...r.spend, openUsd: state.openCostUsd },
                    }
                  : r,
              ),
            }
          : prev,
      ),
    );
  }, []);

  const waiting = view?.repos.reduce((n, r) => n + r.needsYou.length, 0) ?? 0;
  const running = view?.repos.reduce((n, r) => n + r.running.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Home</h2>
          {view && view.repos.length > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {view.repos.length}{" "}
              {view.repos.length === 1 ? "repository" : "repositories"} ·{" "}
              {running} running · {waiting} waiting on you
            </p>
          )}
        </div>
        {repos.length > 0 && (
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
        )}
      </div>

      {error && (
        <p className="text-sm text-rose-300" role="alert">
          {error}
        </p>
      )}

      {repos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories yet. Add a local folder on the left to get started.
        </p>
      ) : loading && !view ? (
        <p className="text-sm text-muted-foreground">Reading the repos…</p>
      ) : view ? (
        <div className="space-y-3">
          {view.repos.map((repo) => (
            <RepoCard
              key={repo.repoPath}
              repo={repo}
              ci={ci[repo.repoPath]}
              onOpen={() => onOpenRepo(repo.repoPath)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
