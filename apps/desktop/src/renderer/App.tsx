import {
  FolderPlus,
  House,
  Play,
  RefreshCw,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Ai } from "@/components/Ai";
import { AuthControls } from "@/components/AuthControls";
import { Docs } from "@/components/Docs";
import { Fix } from "@/components/Fix";
import { FloorPlan } from "@/components/FloorPlan";
import { Gates } from "@/components/Gates";
import { Home } from "@/components/Home";
import { Now } from "@/components/Now";
import { Posture } from "@/components/Posture";
import { Project } from "@/components/Project";
import { ProfileForm } from "@/components/ProfileForm";
import { RepoMap } from "@/components/RepoMap";
import { Scorecard } from "@/components/Scorecard";
import { Settings } from "@/components/Settings";
import { Tasks } from "@/components/Tasks";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { applyTheme } from "@/lib/theme";

type View =
  | "now"
  | "posture"
  | "project"
  | "scorecard"
  | "floorplan"
  | "profile"
  | "gates"
  | "fix"
  | "ai"
  | "tasks"
  | "map"
  | "docs";

const TABS: { id: View; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "posture", label: "Posture" },
  { id: "project", label: "Project" },
  { id: "scorecard", label: "Scorecard" },
  { id: "floorplan", label: "Floor Plan" },
  { id: "profile", label: "Profile" },
  { id: "gates", label: "Gates" },
  { id: "fix", label: "Fix" },
  { id: "ai", label: "AI" },
  { id: "tasks", label: "Tasks" },
  { id: "map", label: "Map" },
  { id: "docs", label: "Docs" },
];

import type {
  NowBadges,
  NowFocus,
  RepoEntry,
  Scorecard as ScorecardData,
  Theme,
  UpdateInfo,
} from "../shared/ipc";

/** The screen tab bar as an ARIA tablist: roving tabindex + arrow-key nav. */
function TabBar({
  view,
  onSelect,
}: {
  view: View;
  onSelect: (v: View) => void;
}) {
  const refs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});

  function onKeyDown(e: React.KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === view);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const target = TABS[next];
    if (!target) return;
    onSelect(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Repository views"
      onKeyDown={onKeyDown}
      className="flex gap-4 border-b border-border text-sm"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={view === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={view === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
          className={`-mb-px rounded-t-sm border-b-2 px-1 pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            view === t.id
              ? "border-sky-500 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** How many items wait on a person in a repo, beside its name in the sidebar. */
function NeedsYouBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-xs font-medium tabular-nums text-amber-300">
      {count}
      <span className="sr-only"> waiting on you</span>
    </span>
  );
}

export function App() {
  // The preload exposes `window.rivetari`; if it failed to load, surface a clear
  // message instead of letting every handler throw into a blank screen.
  const bridgeReady = typeof window.rivetari !== "undefined";
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scorecard, setScorecard] = useState<ScorecardData | null>(null);
  const [running, setRunning] = useState(false);
  // Whether the selected repo's recorded audit (state.json) has been read yet,
  // so "nothing recorded" isn't shown while it's still loading.
  const [recordLoaded, setRecordLoaded] = useState(false);
  // Bumped on every repo pick, so picking the same repo again re-reads it too.
  const [selectSeq, setSelectSeq] = useState(0);
  // The deep-audit swarm runs independently of the (instant) scorecard: `running`
  // above never waits on it. `floorPlanVersion` bumps when a run finishes so the
  // Floor Plan tab reloads the freshly-persisted model.
  const [floorPlanRunning, setFloorPlanRunning] = useState(false);
  const [floorPlanVersion, setFloorPlanVersion] = useState(0);
  const [floorPlanError, setFloorPlanError] = useState<string | null>(null);
  const floorPlanRun = useRef(0);
  // Counts repo picks, so a Run audit that settles after the person has moved
  // to another repo can't put the old repo's scorecard on the new one.
  const auditRun = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("scorecard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The applied theme setting; drives the OS-preference listener below.
  const [theme, setTheme] = useState<Theme>("dark");
  // Set by the opt-in launch update check when a newer release is available.
  const [updateBanner, setUpdateBanner] = useState<UpdateInfo | null>(null);
  // Views the user has opened for the current repo. A view stays mounted once
  // opened (just hidden), so switching tabs doesn't reset its state (unsaved
  // profile edits, expanded gates, the scorecard). Reset when the repo changes.
  const [opened, setOpened] = useState<Set<View>>(
    () => new Set<View>(["scorecard"]),
  );
  // How many items wait on a person in each repo, from main's watchers.
  const [badges, setBadges] = useState<NowBadges>([]);
  // A Needs-you item to bring into view, and a task to open in the Tasks tab;
  // `seq` makes asking for the same one twice count.
  const [nowFocus, setNowFocus] = useState<{ id: string; seq: number } | null>(
    null,
  );
  const [tasksFocus, setTasksFocus] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const focusSeq = useRef(0);
  // What a clicked notification does, renewed each render so the listener,
  // which outlives renders, acts on the repo selected now.
  const onFocusRef = useRef<(focus: NowFocus) => void>(() => undefined);
  onFocusRef.current = ({ repoPath, id }) => {
    if (selected !== repoPath) handleSelect(repoPath);
    showView("now");
    setNowFocus({ id, seq: ++focusSeq.current });
  };

  function showView(next: View): void {
    setView(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }

  useEffect(() => {
    if (!bridgeReady) return;
    window.rivetari.repos.list().then(setRepos, (err: unknown) => {
      setError(errorMessage(err));
    });
    // Apply the saved theme as early as possible (index.html defaults to dark).
    window.rivetari.settings.load().then(
      (s) => {
        setTheme(s.theme);
        applyTheme(s.theme);
        // Opt-in launch update check; show a banner only if one is available.
        if (s.autoCheckUpdates) {
          window.rivetari.update.check().then(
            (info) => info.updateAvailable && setUpdateBanner(info),
            () => {
              // A failed launch check is silent; the user can retry in Settings.
            },
          );
        }
      },
      () => {
        // Settings unreadable — keep the default dark theme.
      },
    );
  }, [bridgeReady]);

  // Main reads the repo on show more often than the rest of the sidebar's.
  useEffect(() => {
    if (!bridgeReady) return;
    window.rivetari.now.select(selected).catch((err: unknown) => {
      setError(errorMessage(err));
    });
  }, [bridgeReady, selected]);

  // The sidebar's badges, and a clicked notification bringing its item up.
  useEffect(() => {
    if (!bridgeReady) return;
    let active = true;
    const offBadges = window.rivetari.now.onBadges(
      (next) => active && setBadges(next),
    );
    window.rivetari.now.badges().then(
      (next) => active && setBadges(next),
      (err: unknown) => active && setError(errorMessage(err)),
    );
    const offFocus = window.rivetari.now.onFocus((focus) =>
      onFocusRef.current(focus),
    );
    return () => {
      active = false;
      offBadges();
      offFocus();
    };
  }, [bridgeReady]);

  // Show the audit the CLI last recorded for the selected repo, as soon as it's
  // picked; Run audit replaces it with a fresh recording.
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setRecordLoaded(false);
    window.rivetari.audit.recorded(selected).then(
      (card) => {
        if (!active) return;
        // A Run audit that finished first already holds the newer recording.
        setScorecard((current) => current ?? card);
        setRecordLoaded(true);
      },
      (err: unknown) => {
        if (!active) return;
        setError(errorMessage(err));
        setRecordLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, [selected, selectSeq]);

  // Re-apply "system" theme when the OS preference changes while the app is open.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  async function handleAdd(): Promise<void> {
    setError(null);
    try {
      setRepos(await window.rivetari.repos.add());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleRemove(path: string): Promise<void> {
    setError(null);
    try {
      setRepos(await window.rivetari.repos.remove(path));
      if (selected === path) {
        setSelected(null);
        setScorecard(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function handleSelect(path: string): void {
    setSettingsOpen(false);
    setSelected(path);
    setSelectSeq((n) => n + 1);
    auditRun.current++;
    setRunning(false);
    setScorecard(null);
    setError(null);
    setView("scorecard");
    // The previous repo's swarm run, if any, no longer speaks for this one.
    floorPlanRun.current++;
    setFloorPlanError(null);
    setFloorPlanRunning(false);
    setFloorPlanVersion((v) => v + 1); // make the Floor Plan tab reload for the new repo
    setOpened(new Set<View>(["scorecard"])); // fresh state for the new repo
    setNowFocus(null);
    setTasksFocus(null);
  }

  /**
   * Run the deep-audit swarm for a repo. The swarm runs Claude agents and costs
   * money, so only the Floor Plan tab's refresh and Posture's Deep audit, each
   * after the person confirms it, call this; nothing else starts it. Non-blocking and independent of the
   * scorecard; main persists the model, so we just bump the version to reload
   * it. Errors are shown inside the Floor Plan tab.
   */
  function triggerFloorPlan(path: string): void {
    // Main aborts a superseded run; only the latest one may settle the UI.
    const run = ++floorPlanRun.current;
    setFloorPlanRunning(true);
    setFloorPlanError(null);
    window.rivetari.floorplan
      .run(path)
      .catch((err: unknown) => {
        if (run === floorPlanRun.current) setFloorPlanError(errorMessage(err));
      })
      .finally(() => {
        if (run !== floorPlanRun.current) return;
        setFloorPlanRunning(false);
        setFloorPlanVersion((v) => v + 1);
      });
  }

  async function handleAudit(): Promise<void> {
    if (!selected) return;
    const run = auditRun.current;
    setRunning(true);
    setError(null);
    try {
      const card = await window.rivetari.audit.run(selected);
      if (run === auditRun.current) setScorecard(card);
    } catch (err) {
      if (run === auditRun.current) setError(errorMessage(err));
    } finally {
      if (run === auditRun.current) setRunning(false);
    }
  }

  const selectedRepo = repos.find((r) => r.path === selected) ?? null;

  if (!bridgeReady) {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-rose-300" role="alert">
          The application bridge failed to load (preload error). Restart the
          app.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30">
        <div className="flex items-center justify-between p-4">
          <h1 className="text-sm font-semibold tracking-tight">Rivetari</h1>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleAdd()}
          >
            <FolderPlus className="h-4 w-4" />
            Add
          </Button>
        </div>
        <div className="px-2 pb-1">
          <Button
            size="sm"
            variant={!selected && !settingsOpen ? "secondary" : "ghost"}
            className="w-full justify-start"
            onClick={() => {
              setSettingsOpen(false);
              setSelected(null);
              setScorecard(null);
            }}
            aria-current={!selected && !settingsOpen ? "page" : undefined}
          >
            <House className="h-4 w-4" />
            Home
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {repos.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No repositories yet. Add a local folder to audit it.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {repos.map((repo) => (
                <li key={repo.path}>
                  <div
                    className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${
                      repo.path === selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelect(repo.path)}
                      aria-current={repo.path === selected ? "true" : undefined}
                      className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={repo.path}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm">{repo.name}</span>
                        <NeedsYouBadge
                          count={
                            badges.find((b) => b.repoPath === repo.path)
                              ?.count ?? 0
                          }
                        />
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {repo.path}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemove(repo.path)}
                      aria-label={`Remove ${repo.name}`}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="px-2 pb-2">
          <Button
            size="sm"
            variant={settingsOpen ? "secondary" : "ghost"}
            className="w-full justify-start"
            onClick={() => setSettingsOpen(true)}
            aria-current={settingsOpen ? "page" : undefined}
          >
            <SettingsIcon className="h-4 w-4" />
            Settings
          </Button>
        </div>
        <AuthControls />
      </aside>

      <main className="flex-1 overflow-y-auto">
        {updateBanner && (
          <div className="flex items-center justify-between gap-3 border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-300">
            <span>
              Update available: v{updateBanner.latestVersion?.replace(/^v/, "")}
              .{" "}
              {updateBanner.url && (
                <a
                  href={updateBanner.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Download
                </a>
              )}
            </span>
            <button
              type="button"
              onClick={() => setUpdateBanner(null)}
              aria-label="Dismiss update notice"
              className="shrink-0 rounded p-1 hover:bg-background/40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {settingsOpen ? (
          <Settings onThemeChange={setTheme} />
        ) : selectedRepo ? (
          // The Floor Plan needs room to breathe; other tabs read best narrower.
          <div
            className={`mx-auto space-y-5 p-6 ${
              view === "floorplan" || view === "map" ? "max-w-7xl" : "max-w-4xl"
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold">
                  {selectedRepo.name}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {selectedRepo.path}
                </p>
              </div>
              {view === "scorecard" && (
                <Button onClick={() => void handleAudit()} disabled={running}>
                  {running ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {running ? "Auditing…" : "Run audit"}
                </Button>
              )}
            </div>

            <TabBar view={view} onSelect={showView} />

            {/* Each panel stays mounted once opened (hidden when inactive), so
                switching tabs preserves its state; `opened` resets per repo. */}
            {opened.has("now") && (
              <div
                id="panel-now"
                role="tabpanel"
                aria-labelledby="tab-now"
                tabIndex={0}
                hidden={view !== "now"}
              >
                {/* key starts the newly selected repo's view afresh. */}
                <Now
                  key={selectedRepo.path}
                  repoPath={selectedRepo.path}
                  focus={nowFocus}
                  onOpenTask={(id) => {
                    setTasksFocus({ id, seq: ++focusSeq.current });
                    showView("tasks");
                  }}
                />
              </div>
            )}

            {opened.has("posture") && (
              <div
                id="panel-posture"
                role="tabpanel"
                aria-labelledby="tab-posture"
                tabIndex={0}
                hidden={view !== "posture"}
              >
                {/* key reads the newly selected repo's record afresh. */}
                <Posture
                  key={selectedRepo.path}
                  repoPath={selectedRepo.path}
                  deepAuditRunning={floorPlanRunning}
                  deepAuditError={floorPlanError}
                  onDeepAudit={() => triggerFloorPlan(selectedRepo.path)}
                  onOpenTask={(id) => {
                    setTasksFocus({ id, seq: ++focusSeq.current });
                    showView("tasks");
                  }}
                />
              </div>
            )}

            {opened.has("project") && (
              <div
                id="panel-project"
                role="tabpanel"
                aria-labelledby="tab-project"
                tabIndex={0}
                hidden={view !== "project"}
              >
                {/* key checks the newly selected repo afresh. */}
                <Project
                  key={selectedRepo.path}
                  repoPath={selectedRepo.path}
                  onOpenTask={(id) => {
                    setTasksFocus({ id, seq: ++focusSeq.current });
                    showView("tasks");
                  }}
                />
              </div>
            )}

            <div
              id="panel-scorecard"
              role="tabpanel"
              aria-labelledby="tab-scorecard"
              tabIndex={0}
              hidden={view !== "scorecard"}
            >
              {error && (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
                  role="alert"
                >
                  {error}
                </p>
              )}
              {scorecard ? (
                <Scorecard data={scorecard} />
              ) : running ? null : !recordLoaded ? (
                <p className="text-sm text-muted-foreground">
                  Reading the recorded audit…
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No audit has been recorded for this repository yet
                  (.rivetari/state.json is missing). Run audit records one the
                  same way <code>rivetari audit</code> does.
                </p>
              )}
            </div>

            {opened.has("floorplan") && (
              <div
                id="panel-floorplan"
                role="tabpanel"
                aria-labelledby="tab-floorplan"
                tabIndex={0}
                hidden={view !== "floorplan"}
              >
                <FloorPlan
                  key={selectedRepo.path}
                  repoPath={selectedRepo.path}
                  running={floorPlanRunning}
                  version={floorPlanVersion}
                  runError={floorPlanError}
                  onRefresh={() => triggerFloorPlan(selectedRepo.path)}
                />
              </div>
            )}

            {opened.has("profile") && (
              <div
                id="panel-profile"
                role="tabpanel"
                aria-labelledby="tab-profile"
                tabIndex={0}
                hidden={view !== "profile"}
              >
                <ProfileForm
                  repoPath={selectedRepo.path}
                  repoName={selectedRepo.name}
                />
              </div>
            )}

            {opened.has("gates") && (
              <div
                id="panel-gates"
                role="tabpanel"
                aria-labelledby="tab-gates"
                tabIndex={0}
                hidden={view !== "gates"}
              >
                <Gates repoPath={selectedRepo.path} />
              </div>
            )}

            {opened.has("fix") && (
              <div
                id="panel-fix"
                role="tabpanel"
                aria-labelledby="tab-fix"
                tabIndex={0}
                hidden={view !== "fix"}
              >
                {/* key resets the panel's run/PR state when the repo changes. */}
                <Fix key={selectedRepo.path} repoPath={selectedRepo.path} />
              </div>
            )}

            {opened.has("ai") && (
              <div
                id="panel-ai"
                role="tabpanel"
                aria-labelledby="tab-ai"
                tabIndex={0}
                hidden={view !== "ai"}
              >
                {/* key resets the panel's draft/run state when the repo changes. */}
                <Ai key={selectedRepo.path} repoPath={selectedRepo.path} />
              </div>
            )}

            {opened.has("tasks") && (
              <div
                id="panel-tasks"
                role="tabpanel"
                aria-labelledby="tab-tasks"
                tabIndex={0}
                hidden={view !== "tasks"}
              >
                {/* key starts a fresh watch (and selection) when the repo changes. */}
                <Tasks
                  key={selectedRepo.path}
                  repoPath={selectedRepo.path}
                  focus={tasksFocus}
                />
              </div>
            )}

            {opened.has("map") && (
              <div
                id="panel-map"
                role="tabpanel"
                aria-labelledby="tab-map"
                tabIndex={0}
                hidden={view !== "map"}
              >
                {/* key loads the newly selected repo's map (and fences to it). */}
                <RepoMap key={selectedRepo.path} repoPath={selectedRepo.path} />
              </div>
            )}

            {opened.has("docs") && (
              <div
                id="panel-docs"
                role="tabpanel"
                aria-labelledby="tab-docs"
                tabIndex={0}
                hidden={view !== "docs"}
              >
                <Docs repoPath={selectedRepo.path} />
              </div>
            )}
          </div>
        ) : (
          <Home
            repos={repos}
            onOpenRepo={(path) => {
              handleSelect(path);
              showView("now");
            }}
          />
        )}
      </main>
    </div>
  );
}
