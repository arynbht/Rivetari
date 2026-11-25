import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  session,
  shell,
} from "electron";
import type { ZodType } from "zod";

import {
  AnthropicKeyRequest,
  AuditRunRequest,
  DocList,
  DocsListRequest,
  DocsReadRequest,
  AuthStatus,
  type AuthUpdate,
  DeviceCodeInfo,
  IpcChannel,
  PingRequest,
  type PingResponse,
  RepoList,
  RepoRemoveRequest,
  Scorecard,
  SettingsSaveRequest,
  SettingsView,
  MapGetRequest,
  MapView,
  type NeedsYouItem,
  NowActionRequest,
  NowActionResult,
  NowBadges,
  NowCi,
  type NowFocus,
  NowHealth,
  NowJudge,
  NowRepoRequest,
  HomeView,
  NowSelectRequest,
  NowState,
  NowTaskRequest,
  Posture,
  PostureDraftRequest,
  PostureDraftResult,
  PostureRequest,
  ProjectDraftRequest,
  ProjectRequest,
  ProjectView,
  HistoryOpenPrRequest,
  HistoryRequest,
  HistoryView,
  TaskAnswerIpcRequest,
  TaskAnswerResult,
  TaskDetail,
  TaskLedger,
  TaskLedgerRequest,
  TaskOpenPrRequest,
  TaskOpenPrResult,
  TaskPrState,
  TaskRequest,
  TasksState,
  TasksWatchRequest,
  UpdateInfo,
} from "../shared/ipc";
import { APP_ID } from "./app-id";
import {
  clearAnthropicKey,
  hasAnthropicKey,
  saveAnthropicKey,
} from "./auth/anthropic-key-store";
import { notConfiguredMessage, resolveClientId } from "./auth/client-id";
import {
  fetchUserLogin,
  pollForToken,
  requestDeviceCode,
} from "./auth/device-flow";
import { clearToken, loadToken, saveToken } from "./auth/token-store";
import { runAudit } from "./engine/audit";
import { openHistoryPr, readHistory } from "./engine/history";
import { defaultHomeDeps, readHome } from "./engine/home";
import { listDocs, readDoc } from "./engine/docs";
import {
  attachMapWebview,
  getMap,
  guardMapSession,
  MapFence,
  MAP_PARTITION,
  mapRequestAllowed,
} from "./engine/map";
import { itemKey, NowHub } from "./engine/now";
import {
  approveAssembly,
  confirmCard,
  judgeFindings,
  openNowPr,
} from "./engine/now-actions";
import { mainCi, nowHealth } from "./engine/now-health";
import { readPosture } from "./engine/posture";
import { draftPostureTask } from "./engine/posture-task";
import { checkProject, readRecords } from "./engine/project";
import { ProjectChecks } from "./engine/project-checks";
import { draftProfileTask } from "./engine/project-task";
import { taskDetail } from "./engine/task-detail";
import { prState } from "./engine/task-pr";
import {
  answerTask,
  openTaskPr,
  shareHub,
  shownTask,
  taskLedger,
  unwatchTasks,
  watchRepoTasks,
} from "./engine/tasks";
import { registeredRepo } from "./store/registered";
import { addRepo, listRepos, removeRepo } from "./store/repos";
import { loadSettings, saveSettings } from "./store/settings";
import { checkForUpdate, DESKTOP_TAG_PREFIX } from "./update/check";

/** The owner/repo whose releases the manual update check queries (ADR-0010). */
const UPDATE_REPO = process.env.RIVETARI_UPDATE_REPO ?? "arynbht/rivetari";

/** The renderer-facing settings: the stored prefs plus whether a key is set. */
async function settingsView(): Promise<SettingsView> {
  const [settings, anthropicKeySet] = await Promise.all([
    loadSettings(),
    hasAnthropicKey(),
  ]);
  return { ...settings, anthropicKeySet };
}

// In dev the renderer is served by Vite (HMR needs a looser policy); in prod it
// loads from the bundle under a strict self-only policy. Either way: no remote
// origins, ever.
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const isDev = Boolean(DEV_RENDERER_URL);
// End-to-end test mode (Playwright): loosens the CSP enough to inject axe-core and
// routes sign-in through a canned device flow so the suite runs without the network.
// Never set in a real session — it gates test-only seams, nothing user-facing.
const isE2E = process.env.RIVETARI_E2E === "1";

/** Canned responses for the GitHub device-flow + user endpoints (E2E only). */
function e2eDeviceFlowFetch(input: unknown): Promise<Response> {
  const href = String(input);
  const body = href.includes("/device/code")
    ? {
        device_code: "e2e-device",
        user_code: "E2E-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      }
    : href.includes("/oauth/access_token")
      ? { access_token: "e2e-token" }
      : href.includes("/user")
        ? { login: "e2e-user" }
        : {};
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

/** Real fetch, or the canned device-flow fetch in E2E, for auth calls only. */
const authFetch: typeof fetch = isE2E
  ? (e2eDeviceFlowFetch as unknown as typeof fetch)
  : fetch;

// Dev convenience: load apps/desktop/.env into process.env so config like the
// GitHub client id persists across restarts without exporting it each time. The
// values aren't secret (an OAuth client id is public) and the file is gitignored.
if (isDev) {
  try {
    const envFile = readFileSync(
      join(import.meta.dirname, "../../.env"),
      "utf8",
    );
    for (const line of envFile.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (key && process.env[key] === undefined) {
        process.env[key] = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // no .env — fine
  }
}

const GITHUB_SCOPE = "repo read:org";

let mainWindow: BrowserWindow | null = null;

/**
 * Cancels the in-flight device-flow poll. A new sign-in or an explicit sign-out
 * aborts the previous poller so a stale one can't overwrite the token or push a
 * late outcome to the renderer.
 */
let signInAbort: AbortController | null = null;

/** The map on show, whose floorplan/ is the only place its session may load from. */
const mapFence = new MapFence();

function sendAuthUpdate(update: AuthUpdate): void {
  mainWindow?.webContents.send(IpcChannel.AuthUpdate, update);
}

/** What each kind of item asks of the person, in the notification's title. */
const NEEDS_YOU_ASK: Record<NeedsYouItem["kind"], string> = {
  intake: "confirm the card",
  route: "approve the route",
  stop: "answer a stop",
  judge: "the judge wants a person",
  merge: "a PR to merge",
  record: "its record fails verification",
};

/** Bring the window up on a Needs-you item (a clicked notification). */
function focusItem(focus: NowFocus): void {
  const window = mainWindow;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send(IpcChannel.NowFocus, focus);
}

/**
 * Notifications raised under E2E, which shows none on the desktop: the suite
 * reads them, and clicks one, through `globalThis.rivetariE2E`.
 */
const e2eNotices: { repoPath: string; id: string; title: string }[] = [];
if (isE2E)
  (globalThis as unknown as { rivetariE2E: unknown }).rivetariE2E = {
    notices: e2eNotices,
    click: (i: number) => {
      const notice = e2eNotices[i];
      if (notice) focusItem({ repoPath: notice.repoPath, id: notice.id });
    },
  };

/**
 * Notifications shown, by repo and item. Each is held until it's clicked or
 * its item leaves Needs you: on Windows a notice moved to the Action Center
 * has fired 'close' but can still be clicked, and a collected one can't.
 */
const shownNotices = new Map<string, Notification>();
const noticeKey = (repoPath: string, key: string) => `${repoPath}\0${key}`;

/** Tell the person, through the OS, that something new waits on them. */
function notifyNeedsYou(repoPath: string, item: NeedsYouItem): void {
  const title = `${item.id} needs you: ${NEEDS_YOU_ASK[item.kind]}`;
  if (isE2E) {
    e2eNotices.push({ repoPath, id: item.id, title });
    return;
  }
  if (!Notification.isSupported()) return;
  const key = noticeKey(repoPath, itemKey(item));
  const notice = new Notification({ title, body: item.title });
  shownNotices.set(key, notice);
  notice.on("click", () => {
    if (shownNotices.get(key) === notice) shownNotices.delete(key);
    focusItem({ repoPath, id: item.id });
  });
  notice.show();
}

/** An item left Needs you: its notice has nothing left to open, so it goes. */
function withdrawNotice(repoPath: string, key: string): void {
  const notice = shownNotices.get(noticeKey(repoPath, key));
  if (!notice) return;
  shownNotices.delete(noticeKey(repoPath, key));
  notice.close();
}

/** A push that doesn't match the contract is said and dropped, never thrown into the watcher. */
function push(channel: string, schema: ZodType, payload: unknown): void {
  const parsed = schema.safeParse(payload);
  if (parsed.success) mainWindow?.webContents.send(channel, parsed.data);
  else
    console.error(
      `[main] dropped a ${channel} push that doesn't match the contract: ${String(parsed.error)}`,
    );
}

/**
 * Each repo's Project view, checked against the repo again when it's opened,
 * after a task in it merges, and once a day (see engine/project-checks).
 */
const projectChecks = new ProjectChecks({
  check: (repoPath) => checkProject(repoPath),
  records: readRecords,
  views: (repoPath) => nowHub.views(repoPath),
  onUpdate: (view) => push(IpcChannel.ProjectUpdate, ProjectView, view),
  onError: (repoPath, err) =>
    console.error(
      `[main] couldn't check ${repoPath} against its profile: ${String(err)}`,
    ),
});

/** Every sidebar repo's tasks, watched while the window is open (see engine/now). */
const nowHub = new NowHub({
  onState: (state) => push(IpcChannel.NowUpdate, NowState, state),
  onBadges: (badges) => push(IpcChannel.NowBadgesUpdate, NowBadges, badges),
  onNew: notifyNeedsYou,
  onGone: withdrawNotice,
  onMerged: (repoPath) => projectChecks.recheck(repoPath),
});
// The Tasks tab listens to the same watchers, so no repo is polled twice.
shareHub(nowHub);

/** How often held Project checks are looked at to see if a day has passed. */
const PROJECT_DUE_EVERY_MS = 60 * 60 * 1000;

/** Watch exactly these repos (the sidebar's list); a failure is said, not thrown. */
function watchRepos(repos: { path: string }[]): void {
  nowHub
    .setRepos(repos.map((r) => r.path))
    .catch((err: unknown) =>
      console.error(
        `[main] couldn't watch the sidebar's repos: ${String(err)}`,
      ),
    );
}

/** Watch the repos in the sidebar now; a failure to list them is said, not thrown. */
function watchSidebarRepos(): void {
  listRepos().then(watchRepos, (err: unknown) =>
    console.error(`[main] couldn't list the repos to watch: ${String(err)}`),
  );
}

/** Hosts `shell.openExternal` is allowed to hand to the OS browser. */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  "github.com",
  "docs.github.com",
  "www.w3.org",
]);

/**
 * Content-Security-Policy applied to every response. Strict self-only in prod; in
 * dev it's loosened only as far as Vite's HMR needs (inline/eval bootstrap + ws),
 * never fully policy-free — the Docs screen renders arbitrary repo Markdown, so
 * even a dev session gets a CSP backstop.
 */
function contentSecurityPolicy(): string {
  const base = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", // bundled CSS + any injected <style>
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ];
  if (isDev || isE2E) {
    // E2E needs inline <script> so Playwright can inject axe-core for the audit.
    base.push(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' ws: http://localhost:*",
    );
  } else {
    base.push("script-src 'self'", "connect-src 'self'");
  }
  return base.join("; ");
}

/** The exact URL our renderer loads from (the only navigation we allow in-window). */
function rendererUrl(): string {
  return (
    DEV_RENDERER_URL ??
    pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href
  );
}

/** Open an allow-listed https link in the OS browser; silently drop anything else. */
function openExternalIfAllowed(url: string): void {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
    ) {
      void shell.openExternal(url);
    }
  } catch {
    // not a valid URL — ignore
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1140,
    height: 780,
    show: false,
    backgroundColor: "#0b0f17",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // For the Map tab's one webview; will-attach-webview below refuses any
      // other and locks the map's down.
      webviewTag: true,
    },
  });

  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    // Nobody is left to show the tasks to.
    void unwatchTasks();
    void nowHub.stop();
  });
  watchSidebarRepos();

  // Show as soon as the first paint is ready; in E2E show immediately so a slow or
  // non-painting headless renderer can't keep the window (and Playwright) waiting.
  if (isE2E) window.show();
  else window.once("ready-to-show", () => window.show());

  if (isDev || isE2E) {
    if (isDev) window.webContents.openDevTools({ mode: "detach" });
    // Forward renderer console + load failures to the main process so they're
    // visible when driving the app headlessly (dev or E2E on CI).
    window.webContents.on(
      "console-message",
      (_event, level, message, line, sourceId) => {
        console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      },
    );
    window.webContents.on("did-fail-load", (_event, code, desc, url) => {
      console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(
        `[renderer] render-process-gone ${JSON.stringify(details)}`,
      );
    });
  }

  // Only the map's webview attaches, on the map's session, loading the map.
  window.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      if (!attachMapWebview({ params, webPreferences }, mapFence.dir))
        event.preventDefault();
    },
  );
  // The map opens no windows and navigates nowhere outside floorplan/.
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (navigation, url) => {
      if (!mapRequestAllowed(url, mapFence.dir)) navigation.preventDefault();
    });
  });

  // Never open a second window in-app; route an allow-listed link to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  // Block navigation anywhere but our own renderer URL (prefix covers #hash and
  // ?query). A bare "file://" prefix would let any local file through, so match
  // the exact renderer URL instead.
  const allowedPrefix = rendererUrl();
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
      openExternalIfAllowed(url);
    }
  });

  if (DEV_RENDERER_URL) {
    void window.loadURL(DEV_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

/**
 * The registered repo a request names, as main's own list spells it. Every
 * handler that takes a repo path goes through here, so a renderer that sends
 * any other folder is refused before anything there is read or written.
 */
async function registered(asked: string): Promise<string> {
  return registeredRepo(asked, await listRepos());
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.Ping, (_event, raw: unknown) => {
    const request = PingRequest.parse(raw); // re-validate the renderer's request
    const response: PingResponse = {
      reply: `pong: ${request.message}`,
      version: app.getVersion(),
    };
    return response;
  });

  ipcMain.handle(IpcChannel.ReposList, async () =>
    RepoList.parse(await listRepos()),
  );

  ipcMain.handle(IpcChannel.ReposAdd, async () => {
    const result = await dialog.showOpenDialog({
      title: "Add a repository folder",
      properties: ["openDirectory"],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) {
      return RepoList.parse(await listRepos());
    }
    const repos = RepoList.parse(await addRepo(chosen));
    watchRepos(repos);
    return repos;
  });

  ipcMain.handle(IpcChannel.ReposRemove, async (_event, raw: unknown) => {
    const { path } = RepoRemoveRequest.parse(raw);
    const repos = RepoList.parse(await removeRepo(path));
    projectChecks.forget(path);
    watchRepos(repos);
    return repos;
  });

  ipcMain.handle(IpcChannel.HomeGet, async () =>
    // The sidebar's own list, never a path the renderer sends.
    HomeView.parse(
      await readHome(
        defaultHomeDeps({
          listRepos,
          state: (repoPath) => nowHub.state(repoPath),
          views: (repoPath) => nowHub.views(repoPath),
        }),
      ),
    ),
  );

  ipcMain.handle(IpcChannel.NowGet, async (_event, raw: unknown) => {
    const { repoPath: asked } = NowRepoRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowState.parse(nowHub.state(repoPath));
  });

  ipcMain.handle(IpcChannel.NowSelect, async (_event, raw: unknown) => {
    const { repoPath: asked } = NowSelectRequest.parse(raw);
    const repoPath = asked === null ? null : await registered(asked);
    await nowHub.select(repoPath);
    // Opening a repo is one of the times its profile is checked again.
    if (repoPath !== null) projectChecks.recheck(repoPath);
  });

  ipcMain.handle(IpcChannel.NowBadges, () => NowBadges.parse(nowHub.badges()));

  ipcMain.handle(IpcChannel.NowConfirm, async (_event, raw: unknown) => {
    const { repoPath: asked, ...request } = NowActionRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowActionResult.parse(await confirmCard(repoPath, request));
  });

  ipcMain.handle(IpcChannel.NowApprove, async (_event, raw: unknown) => {
    const { repoPath: asked, ...request } = NowActionRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowActionResult.parse(await approveAssembly(repoPath, request));
  });

  ipcMain.handle(IpcChannel.NowJudge, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = NowTaskRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowJudge.parse(await judgeFindings(repoPath, id));
  });

  ipcMain.handle(IpcChannel.NowOpenPr, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = NowTaskRequest.parse(raw);
    const repoPath = await registered(asked);
    // As with tasks:openPr, the URL is the one the task's ledger records.
    return TaskOpenPrResult.parse(
      await openNowPr(nowHub.views(repoPath), id, (url) =>
        isE2E ? Promise.resolve() : shell.openExternal(url),
      ),
    );
  });

  ipcMain.handle(IpcChannel.NowHealth, async (_event, raw: unknown) => {
    const { repoPath: asked } = NowRepoRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowHealth.parse(await nowHealth(repoPath, nowHub.views(repoPath)));
  });

  ipcMain.handle(IpcChannel.NowCi, async (_event, raw: unknown) => {
    const { repoPath: asked } = NowRepoRequest.parse(raw);
    const repoPath = await registered(asked);
    return NowCi.parse(await mainCi(repoPath, await loadToken()));
  });

  ipcMain.handle(IpcChannel.AuditRun, async (_event, raw: unknown) => {
    const { repoPath: asked } = AuditRunRequest.parse(raw);
    const repoPath = await registered(asked);
    const token = (await loadToken()) ?? undefined;
    return Scorecard.parse(await runAudit(repoPath, token));
  });

  ipcMain.handle(IpcChannel.PostureGet, async (_event, raw: unknown) => {
    const { repoPath: asked } = PostureRequest.parse(raw);
    const repoPath = await registered(asked);
    return Posture.parse(await readPosture(repoPath));
  });

  ipcMain.handle(IpcChannel.PostureDraft, async (_event, raw: unknown) => {
    const { repoPath: asked, draft } = PostureDraftRequest.parse(raw);
    const repoPath = await registered(asked);
    return PostureDraftResult.parse(await draftPostureTask(repoPath, draft));
  });

  ipcMain.handle(IpcChannel.ProjectGet, async (_event, raw: unknown) => {
    const { repoPath: asked } = ProjectRequest.parse(raw);
    const repoPath = await registered(asked);
    return ProjectView.parse(await projectChecks.view(repoPath));
  });

  ipcMain.handle(IpcChannel.ProjectRefresh, async (_event, raw: unknown) => {
    const { repoPath: asked } = ProjectRequest.parse(raw);
    const repoPath = await registered(asked);
    return ProjectView.parse(await projectChecks.view(repoPath, true));
  });

  ipcMain.handle(IpcChannel.ProjectDraft, async (_event, raw: unknown) => {
    const { repoPath: asked, keys } = ProjectDraftRequest.parse(raw);
    const repoPath = await registered(asked);
    return PostureDraftResult.parse(await draftProfileTask(repoPath, keys));
  });

  ipcMain.handle(IpcChannel.HistoryGet, async (_event, raw: unknown) => {
    const { repoPath: asked } = HistoryRequest.parse(raw);
    const repoPath = await registered(asked);
    return HistoryView.parse(await readHistory(repoPath));
  });

  ipcMain.handle(IpcChannel.HistoryOpenPr, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = HistoryOpenPrRequest.parse(raw);
    const repoPath = await registered(asked);
    // As with tasks:openPr, the URL is the one the task's ledger records.
    return TaskOpenPrResult.parse(
      await openHistoryPr(repoPath, id, (url) =>
        isE2E ? Promise.resolve() : shell.openExternal(url),
      ),
    );
  });

  ipcMain.handle(IpcChannel.TasksWatch, async (_event, raw: unknown) => {
    const { repoPath: asked } = TasksWatchRequest.parse(raw);
    const repoPath = await registered(asked);
    return TasksState.parse(
      await watchRepoTasks(repoPath, (state) =>
        push(IpcChannel.TasksUpdate, TasksState, state),
      ),
    );
  });

  ipcMain.handle(IpcChannel.TasksDetail, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = TaskRequest.parse(raw);
    const repoPath = await registered(asked);
    return TaskDetail.parse(
      await taskDetail(repoPath, shownTask(repoPath, id)),
    );
  });

  ipcMain.handle(IpcChannel.TasksPr, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = TaskRequest.parse(raw);
    const repoPath = await registered(asked);
    // The PR is the one the task's ledger records, never one the renderer sends.
    return TaskPrState.parse(
      await prState(repoPath, shownTask(repoPath, id).pr, await loadToken()),
    );
  });

  ipcMain.handle(IpcChannel.TasksUnwatch, async () => {
    await unwatchTasks();
  });

  ipcMain.handle(IpcChannel.MapGet, async (_event, raw: unknown) => {
    const { repoPath: asked } = MapGetRequest.parse(raw);
    const repoPath = await registered(asked);
    return MapView.parse(await mapFence.open(repoPath, getMap));
  });

  ipcMain.handle(IpcChannel.TasksAnswer, async (_event, raw: unknown) => {
    const { repoPath: asked, ...request } = TaskAnswerIpcRequest.parse(raw);
    const repoPath = await registered(asked);
    return TaskAnswerResult.parse(await answerTask(repoPath, request));
  });

  ipcMain.handle(IpcChannel.TasksLedger, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = TaskLedgerRequest.parse(raw);
    const repoPath = await registered(asked);
    return TaskLedger.parse(taskLedger(repoPath, id));
  });

  ipcMain.handle(IpcChannel.TasksOpenPr, async (_event, raw: unknown) => {
    const { repoPath: asked, id } = TaskOpenPrRequest.parse(raw);
    const repoPath = await registered(asked);
    // Any https host: a PR can live on GitHub Enterprise, and the URL is the
    // one the task's signed ledger records, not one the renderer sends.
    return TaskOpenPrResult.parse(
      await openTaskPr(repoPath, id, (url) =>
        isE2E ? Promise.resolve() : shell.openExternal(url),
      ),
    );
  });

  ipcMain.handle(IpcChannel.AuthStatus, async () => {
    const token = await loadToken();
    if (!token) return AuthStatus.parse({ signedIn: false, login: null });
    try {
      const login = await fetchUserLogin(token, authFetch);
      return AuthStatus.parse({ signedIn: true, login });
    } catch {
      // Token present but unverifiable (offline / revoked) — still "signed in".
      return AuthStatus.parse({ signedIn: true, login: null });
    }
  });

  ipcMain.handle(IpcChannel.AuthSignIn, async () => {
    // Looked up per sign-in, so registering the App with the shell open works.
    const resolved = await resolveClientId();
    if (!resolved) throw new Error(notConfiguredMessage());
    const { clientId } = resolved;
    const deps = { fetch: authFetch };
    const code = await requestDeviceCode(clientId, GITHUB_SCOPE, deps);
    // Open github.com/login/device for the user (host is allow-listed). Skipped in
    // E2E so the suite doesn't spawn a real browser.
    if (!isE2E) openExternalIfAllowed(code.verificationUri);

    // Abort any previous poll before starting a new one (double sign-in click).
    signInAbort?.abort();
    const controller = new AbortController();
    signInAbort = controller;
    const { signal } = controller;

    // Poll in the background; push the outcome to the renderer when it lands.
    // If this poll was superseded (new sign-in) or cancelled (sign-out), it must
    // not save a token or push a stale outcome.
    void (async () => {
      try {
        const token = await pollForToken(clientId, code, deps, signal);
        if (signal.aborted) return;
        await saveToken(token);
        let login = "";
        try {
          login = await fetchUserLogin(token, authFetch);
        } catch {
          // keep login empty; the status call will refresh it
        }
        if (signal.aborted) return;
        sendAuthUpdate({ status: "signed-in", login });
      } catch (err) {
        if (signal.aborted) return;
        sendAuthUpdate({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (signInAbort === controller) signInAbort = null;
      }
    })();

    return DeviceCodeInfo.parse({
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn,
    });
  });

  ipcMain.handle(IpcChannel.AuthSignOut, async () => {
    // Stop any in-flight poll so it can't re-save a token after we clear it.
    signInAbort?.abort();
    signInAbort = null;
    await clearToken();
    return AuthStatus.parse({ signedIn: false, login: null });
  });

  ipcMain.handle(IpcChannel.DocsList, async (_event, raw: unknown) => {
    const { repoPath: asked } = DocsListRequest.parse(raw);
    const repoPath = await registered(asked);
    return DocList.parse(await listDocs(repoPath));
  });

  ipcMain.handle(IpcChannel.DocsRead, async (_event, raw: unknown) => {
    const { repoPath: asked, path } = DocsReadRequest.parse(raw);
    const repoPath = await registered(asked);
    return readDoc(repoPath, path);
  });

  ipcMain.handle(IpcChannel.SettingsLoad, async () =>
    SettingsView.parse(await settingsView()),
  );

  ipcMain.handle(IpcChannel.SettingsSave, async (_event, raw: unknown) => {
    const patch = SettingsSaveRequest.parse(raw);
    await saveSettings(patch);
    return SettingsView.parse(await settingsView());
  });

  ipcMain.handle(
    IpcChannel.SettingsSetAnthropicKey,
    async (_event, raw: unknown) => {
      const { key } = AnthropicKeyRequest.parse(raw);
      // An empty string clears the stored key; otherwise store it encrypted.
      if (key.trim() === "") await clearAnthropicKey();
      else await saveAnthropicKey(key.trim());
      return SettingsView.parse(await settingsView());
    },
  );

  ipcMain.handle(IpcChannel.UpdateCheck, async () => {
    const info = await checkForUpdate({
      fetch,
      currentVersion: app.getVersion(),
      repo: UPDATE_REPO,
      token: (await loadToken()) ?? undefined,
      tagPrefix: DESKTOP_TAG_PREFIX,
    });
    return UpdateInfo.parse(info);
  });
}

app.whenReady().then(
  () => {
    // Enforce a CSP on every response. Strict in prod; dev loosens only enough for
    // Vite's inline bootstrap + HMR websocket (see contentSecurityPolicy). The Docs
    // screen renders arbitrary repo Markdown, so even dev keeps a policy backstop.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy()],
        },
      });
    });

    guardMapSession(
      session.fromPartition(MAP_PARTITION),
      () => mapFence.dir,
      (url) => {
        const blocked = mapFence.block(url);
        if (blocked)
          mainWindow?.webContents.send(IpcChannel.MapBlocked, blocked);
      },
    );

    // Windows shows an app's notifications only under its app id, the one
    // the installer registers (electron-builder.yml's appId).
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);

    registerIpcHandlers();
    createWindow();
    setInterval(() => projectChecks.due(), PROJECT_DUE_EVERY_MS);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
  (err: unknown) => {
    // Make a startup failure loud (it otherwise manifests as "no window" in E2E).
    process.stderr.write(`[main] app failed to start: ${String(err)}\n`);
    console.error(err);
  },
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
