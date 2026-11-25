// Home's read: one line per registered repo, from the readers the per-repo
// views already use. What's running and what needs the owner come from the
// Now watchers' last read; spend this week from history.jsonl as the health
// strip works it out; the posture gate from Posture's phase lens; the autonomy
// level as profile.yml configures it. main's CI isn't read here: the renderer
// asks for it per repo, so a slow GitHub never holds Home up.
// Kept free of any electron import so it unit-tests as plain functions.
import { loadProfile } from "@arynbht/rivetari-engine";
import { historyRows, type TaskView } from "@arynbht/rivetari-runtime";

import type {
  HomeRepo,
  HomeView,
  NowState,
  PostureLens,
  RepoEntry,
} from "../../shared/ipc";
import { spendFrom } from "./now-health";
import { readPhase } from "./posture";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export interface HomeDeps {
  /** The registered repos: Home reads these and no others. */
  listRepos: () => Promise<RepoEntry[]>;
  /** The Now hub's state and views for a repo, as it last read them. */
  state: (repoPath: string) => NowState;
  views: (repoPath: string) => TaskView[];
  loadProfile: typeof loadProfile;
  historyRows: typeof historyRows;
  readPhase: (
    repoPath: string,
    declared: string | null,
  ) => Promise<PostureLens | null>;
  now: () => Date;
}

export const defaultHomeDeps = (
  hub: Pick<HomeDeps, "listRepos" | "state" | "views">,
): HomeDeps => ({
  ...hub,
  loadProfile,
  historyRows,
  readPhase,
  now: () => new Date(),
});

/** One repo's line; each part fails on its own and says why. */
export async function homeRepo(
  repo: RepoEntry,
  deps: HomeDeps,
): Promise<HomeRepo> {
  const state = deps.state(repo.path);
  const views = deps.views(repo.path);

  const profile = await deps.loadProfile(repo.path).then(
    (p) => ({ profile: p, error: null }),
    (err: unknown) => ({ profile: null, error: message(err) }),
  );

  const spend = await deps.historyRows(repo.path).then(
    (rows) => {
      const s = spendFrom(rows, views, deps.now());
      return { weekUsd: s.weekUsd, openUsd: s.openUsd, error: null };
    },
    (err: unknown) => ({
      weekUsd: 0,
      openUsd: spendFrom([], views, deps.now()).openUsd,
      error: message(err),
    }),
  );

  let phase: HomeRepo["phase"] = null;
  let phaseNote: string | null = null;
  try {
    const lens = await deps.readPhase(
      repo.path,
      profile.profile?.phase ?? null,
    );
    if (lens)
      phase = {
        declared: lens.declaredPhase,
        inferred: lens.inferredPhase,
        allGreen: lens.allGreen,
        nextPhase: lens.nextPhase,
        blockers: lens.blockers.length,
      };
    else phaseNote = "no audit recorded yet: run rivetari audit";
  } catch (err) {
    phaseNote = `the posture gate can't be read: ${message(err)}`;
  }

  return {
    repoPath: repo.path,
    name: repo.name,
    ready: state.ready,
    error: state.error,
    running: state.running,
    needsYou: state.needsYou.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      why: n.why,
    })),
    spend,
    autonomy: {
      configured: profile.profile?.autonomy ?? null,
      error: profile.error,
    },
    phase,
    phaseNote,
  };
}

/** Every registered repo's line, in the sidebar's order. */
export async function readHome(deps: HomeDeps): Promise<HomeView> {
  const repos = await deps.listRepos();
  return { repos: await Promise.all(repos.map((r) => homeRepo(r, deps))) };
}
