// The preload bridge: the ONLY surface the renderer can reach. It exposes a
// typed, allow-listed API over contextBridge; the renderer never touches
// ipcRenderer, fs, git, or the network. Every request is zod-validated before it
// leaves and every response is zod-validated before the renderer sees it.
import type { Profile } from "@arynbht/rivetari-catalog";
import { contextBridge, ipcRenderer } from "electron";

import {
  AiApplyRequest,
  AiApplyResult,
  AiRunRequest,
  AiRunResult,
  AiTasks,
  AnthropicKeyRequest,
  AuditRunRequest,
  AuthStatus,
  AuthUpdate,
  DeviceCodeInfo,
  DocContent,
  DocList,
  DocsListRequest,
  DocsReadRequest,
  EvidenceRequest,
  FloorPlanGetRequest,
  FloorPlanProgress,
  FloorPlanRunRequest,
  FloorPlanView,
  FixPlan,
  FixPlanRequest,
  FixPrOutcome,
  GatesReport,
  GatesStatusRequest,
  IpcChannel,
  PingRequest,
  PingResponse,
  ProfileLoadRequest,
  ProfileMeta,
  ProfileResponse,
  ProfileSaveRequest,
  RepoList,
  RepoRemoveRequest,
  Scorecard,
  SettingsSaveRequest,
  SettingsView,
  MapBlocked,
  MapGetRequest,
  MapView,
  NowActionRequest,
  NowActionResult,
  NowBadges,
  NowCi,
  NowFocus,
  NowHealth,
  NowJudge,
  NowRepoRequest,
  NowSelectRequest,
  NowState,
  NowTaskRequest,
  Posture,
  PostureDraft,
  PostureDraftRequest,
  PostureDraftResult,
  PostureRequest,
  ProjectDraftRequest,
  ProjectRequest,
  ProjectView,
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
  WaiveRequest,
} from "../shared/ipc";

const api = {
  /** Smoke round-trip: validate the request, invoke main, validate the reply. */
  async ping(message: string) {
    const request = PingRequest.parse({ message });
    const raw: unknown = await ipcRenderer.invoke(IpcChannel.Ping, request);
    return PingResponse.parse(raw);
  },

  repos: {
    async list() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.ReposList);
      return RepoList.parse(raw);
    },
    /** Opens a native folder picker in main; returns the updated list. */
    async add() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.ReposAdd);
      return RepoList.parse(raw);
    },
    async remove(path: string) {
      const request = RepoRemoveRequest.parse({ path });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ReposRemove,
        request,
      );
      return RepoList.parse(raw);
    },
  },

  audit: {
    /** The audit recorded in .rivetari/state.json, or null when there's none. */
    async recorded(repoPath: string) {
      const request = AuditRunRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.AuditRecorded,
        request,
      );
      return Scorecard.nullable().parse(raw);
    },
    /** Run the audit as `rivetari audit` does, record it, and return it. */
    async run(repoPath: string) {
      const request = AuditRunRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.AuditRun,
        request,
      );
      return Scorecard.parse(raw);
    },
  },

  auth: {
    async status() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.AuthStatus);
      return AuthStatus.parse(raw);
    },
    /** Starts the device flow; returns the code to show the user. */
    async signIn() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.AuthSignIn);
      return DeviceCodeInfo.parse(raw);
    },
    async signOut() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.AuthSignOut);
      return AuthStatus.parse(raw);
    },
    /** Subscribe to the background sign-in outcome; returns an unsubscribe fn. */
    onUpdate(callback: (update: AuthUpdate) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        // A listener must not throw: an unparseable push becomes a surfaced error
        // rather than an uncaught exception in the IPC event loop.
        const parsed = AuthUpdate.safeParse(payload);
        callback(
          parsed.success
            ? parsed.data
            : {
                status: "error",
                message: "received a malformed sign-in update",
              },
        );
      };
      ipcRenderer.on(IpcChannel.AuthUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.AuthUpdate, listener);
      };
    },
  },

  profile: {
    /** The catalog enum lists that drive the form (types, flags, lanes, …). */
    async meta() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.ProfileMeta);
      return ProfileMeta.parse(raw);
    },
    /** The repo's profile, or null if it has none. Validated by the engine. */
    async load(repoPath: string): Promise<Profile | null> {
      const request = ProfileLoadRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ProfileLoad,
        request,
      );
      return ProfileResponse.parse(raw) as Profile | null;
    },
    /** Write the profile with a minimal diff; returns the saved profile. */
    async save(repoPath: string, profile: Profile): Promise<Profile> {
      const request = ProfileSaveRequest.parse({ repoPath, profile });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ProfileSave,
        request,
      );
      return ProfileResponse.parse(raw) as Profile;
    },
  },

  gates: {
    async status(repoPath: string) {
      const request = GatesStatusRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.GatesStatus,
        request,
      );
      return GatesReport.parse(raw);
    },
    /** Waive a control (reason + expiry); returns the recomputed gates. */
    async waive(request: WaiveRequest) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.GatesWaive,
        WaiveRequest.parse(request),
      );
      return GatesReport.parse(raw);
    },
    /** Attach evidence for a needs-evidence control; returns recomputed gates. */
    async attachEvidence(request: EvidenceRequest) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.GatesEvidence,
        EvidenceRequest.parse(request),
      );
      return GatesReport.parse(raw);
    },
  },

  posture: {
    /** The recorded scorecard and phase lens, the trend, waivers and evidence. */
    async get(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.PostureGet,
        PostureRequest.parse({ repoPath }),
      );
      return Posture.parse(raw);
    },
    /** Draft a task card for gaps, a waiver or evidence, through the runtime. */
    async draft(repoPath: string, draft: PostureDraft) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.PostureDraft,
        PostureDraftRequest.parse({ repoPath, draft }),
      );
      return PostureDraftResult.parse(raw);
    },
  },

  project: {
    /** profile.yml against the repo, as last checked, with what it records. */
    async get(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ProjectGet,
        ProjectRequest.parse({ repoPath }),
      );
      return ProjectView.parse(raw);
    },
    /** Check the repo against profile.yml now. */
    async refresh(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ProjectRefresh,
        ProjectRequest.parse({ repoPath }),
      );
      return ProjectView.parse(raw);
    },
    /** Draft a task card that brings the picked rows of profile.yml in line. */
    async draft(repoPath: string, keys: string[]) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.ProjectDraft,
        ProjectDraftRequest.parse({ repoPath, keys }),
      );
      return PostureDraftResult.parse(raw);
    },
    /** Hears a repo's view after a check main ran by itself; returns an unsubscribe fn. */
    onUpdate(callback: (view: ProjectView) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = ProjectView.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.ProjectUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.ProjectUpdate, listener);
      };
    },
  },

  fix: {
    /** Dry-run: the changes `rivetari fix` would make, grouped per control. */
    async plan(repoPath: string) {
      const request = FixPlanRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.FixPlan,
        request,
      );
      return FixPlan.parse(raw);
    },
    /** Apply the changes to the working tree; returns the applied results. */
    async apply(repoPath: string) {
      const request = FixPlanRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.FixApply,
        request,
      );
      return FixPlan.parse(raw);
    },
    /** Open (or reuse) a Rivetari PR with the changes; returns the PR outcome. */
    async openPr(repoPath: string) {
      const request = FixPlanRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.FixOpenPr,
        request,
      );
      return FixPrOutcome.parse(raw);
    },
  },

  ai: {
    /** The Claude-drafted tasks available (from the bundled prompts). */
    async tasks() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.AiTasks);
      return AiTasks.parse(raw);
    },
    /** Draft the task on the subscription CLI; returns the draft (not written). */
    async run(repoPath: string, task: string) {
      const request = AiRunRequest.parse({ repoPath, task });
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.AiRun, request);
      return AiRunResult.parse(raw);
    },
    async apply(request: AiApplyRequest) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.AiApply,
        AiApplyRequest.parse(request),
      );
      return AiApplyResult.parse(raw);
    },
    async openPr(request: AiApplyRequest) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.AiOpenPr,
        AiApplyRequest.parse(request),
      );
      return FixPrOutcome.parse(raw);
    },
  },

  docs: {
    async list(repoPath: string) {
      const request = DocsListRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.DocsList,
        request,
      );
      return DocList.parse(raw);
    },
    async read(repoPath: string, path: string) {
      const request = DocsReadRequest.parse({ repoPath, path });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.DocsRead,
        request,
      );
      return DocContent.parse(raw);
    },
  },

  floorplan: {
    /** The last persisted floor plan + whether a deep audit can run + staleness. */
    async get(repoPath: string) {
      const request = FloorPlanGetRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.FloorPlanGet,
        request,
      );
      return FloorPlanView.parse(raw);
    },
    /** Run the deep-audit swarm (subscription CLI); persists + returns the model. */
    async run(repoPath: string) {
      const request = FloorPlanRunRequest.parse({ repoPath });
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.FloorPlanRun,
        request,
      );
      return FloorPlanView.parse(raw);
    },
    /** Subscribe to swarm progress; returns an unsubscribe fn. */
    onProgress(callback: (progress: FloorPlanProgress) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        // A malformed push is dropped rather than thrown into the IPC event loop.
        const parsed = FloorPlanProgress.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.FloorPlanProgress, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.FloorPlanProgress, listener);
      };
    },
  },

  tasks: {
    /**
     * Watch a repo's tasks (read-only), replacing any earlier watch; resolves with
     * the current state, and `onUpdate` hears every change after it.
     */
    async watch(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksWatch,
        TasksWatchRequest.parse({ repoPath }),
      );
      return TasksState.parse(raw);
    },
    async unwatch() {
      await ipcRenderer.invoke(IpcChannel.TasksUnwatch);
    },
    /** Allow or deny a task's open stops; the answer is recorded under your name. */
    async answer(repoPath: string, id: string, allow: boolean, note: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksAnswer,
        TaskAnswerIpcRequest.parse({ repoPath, id, allow, note }),
      );
      return TaskAnswerResult.parse(raw);
    },
    /** Open a task's PR in the OS browser (the URL comes from its ledger). */
    async openPr(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksOpenPr,
        TaskOpenPrRequest.parse({ repoPath, id }),
      );
      return TaskOpenPrResult.parse(raw);
    },
    /** A watched task's ledger entries; the list leaves them out. */
    async ledger(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksLedger,
        TaskLedgerRequest.parse({ repoPath, id }),
      );
      return TaskLedger.parse(raw);
    },
    /** A watched task in full: card and criteria, route, plan, proof, judge rounds. */
    async detail(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksDetail,
        TaskRequest.parse({ repoPath, id }),
      );
      return TaskDetail.parse(raw);
    },
    /** A watched task's PR as GitHub has it now; reads GitHub only when signed in. */
    async pr(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.TasksPr,
        TaskRequest.parse({ repoPath, id }),
      );
      return TaskPrState.parse(raw);
    },
    /** Subscribe to task changes; returns an unsubscribe fn. */
    onUpdate(callback: (state: TasksState) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        // A malformed push is dropped rather than thrown into the IPC event loop.
        const parsed = TasksState.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.TasksUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.TasksUpdate, listener);
      };
    },
  },

  now: {
    /** A repo's Now state as main last read it; `onUpdate` hears every change. */
    async get(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowGet,
        NowRepoRequest.parse({ repoPath }),
      );
      return NowState.parse(raw);
    },
    /** The repo on show (or none), which main reads more often. */
    async select(repoPath: string | null) {
      await ipcRenderer.invoke(
        IpcChannel.NowSelect,
        NowSelectRequest.parse({ repoPath }),
      );
    },
    /** Confirm a card, as `rivetari task confirm` does; `shown` is what was read. */
    async confirm(repoPath: string, id: string, shown: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowConfirm,
        NowActionRequest.parse({ repoPath, id, shown }),
      );
      return NowActionResult.parse(raw);
    },
    /** Approve a route, as `rivetari task approve` does; `shown` is what was read. */
    async approve(repoPath: string, id: string, shown: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowApprove,
        NowActionRequest.parse({ repoPath, id, shown }),
      );
      return NowActionResult.parse(raw);
    },
    /** A task's latest judge round, or null before any verdict. */
    async judge(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowJudge,
        NowTaskRequest.parse({ repoPath, id }),
      );
      return NowJudge.parse(raw);
    },
    /** Open a task's PR in the OS browser (the URL comes from its ledger). */
    async openPr(repoPath: string, id: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowOpenPr,
        NowTaskRequest.parse({ repoPath, id }),
      );
      return TaskOpenPrResult.parse(raw);
    },
    async health(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowHealth,
        NowRepoRequest.parse({ repoPath }),
      );
      return NowHealth.parse(raw);
    },
    /** main's CI; reads GitHub only when signed in. */
    async ci(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.NowCi,
        NowRepoRequest.parse({ repoPath }),
      );
      return NowCi.parse(raw);
    },
    async badges() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.NowBadges);
      return NowBadges.parse(raw);
    },
    /** Subscribe to every repo's Now state; returns an unsubscribe fn. */
    onUpdate(callback: (state: NowState) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        // A malformed push is dropped rather than thrown into the IPC event loop.
        const parsed = NowState.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.NowUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.NowUpdate, listener);
      };
    },
    onBadges(callback: (badges: NowBadges) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = NowBadges.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.NowBadgesUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.NowBadgesUpdate, listener);
      };
    },
    /** A clicked notification's item, to show; returns an unsubscribe fn. */
    onFocus(callback: (focus: NowFocus) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = NowFocus.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.NowFocus, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.NowFocus, listener);
      };
    },
  },

  map: {
    /** The repo's floorplan map (or why there's none); fences the map's session to it. */
    async get(repoPath: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.MapGet,
        MapGetRequest.parse({ repoPath }),
      );
      return MapView.parse(raw);
    },
    /** Subscribe to the requests the map's session cancelled; returns an unsubscribe fn. */
    onBlocked(callback: (blocked: MapBlocked) => void) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = MapBlocked.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(IpcChannel.MapBlocked, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannel.MapBlocked, listener);
      };
    },
  },

  settings: {
    /** The personal settings plus whether an Anthropic key is stored. */
    async load() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.SettingsLoad);
      return SettingsView.parse(raw);
    },
    /** Apply a partial update; returns the full, saved settings view. */
    async save(patch: SettingsSaveRequest) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.SettingsSave,
        SettingsSaveRequest.parse(patch),
      );
      return SettingsView.parse(raw);
    },
    /** Store (non-empty) or clear (empty) the Anthropic key; returns the view. */
    async setAnthropicKey(key: string) {
      const raw: unknown = await ipcRenderer.invoke(
        IpcChannel.SettingsSetAnthropicKey,
        AnthropicKeyRequest.parse({ key }),
      );
      return SettingsView.parse(raw);
    },
  },

  update: {
    /** Query GitHub Releases for a newer version (uses the signed-in token). */
    async check() {
      const raw: unknown = await ipcRenderer.invoke(IpcChannel.UpdateCheck);
      return UpdateInfo.parse(raw);
    },
  },
};

/** The shape exposed as `window.rivetari` in the renderer. */
export type RivetariApi = typeof api;

contextBridge.exposeInMainWorld("rivetari", api);
