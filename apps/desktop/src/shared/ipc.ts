// The IPC contract shared by main, preload, and renderer. Every channel has a
// zod schema validated on BOTH sides: the main process re-validates each request
// it receives, and the preload re-validates each response before handing it to
// the renderer. The renderer only ever sees the typed `window.rivetari` surface
// (see preload) — never ipcRenderer, fs, git, or the network directly.
import { z } from "zod";

/** Allow-listed channel names. The preload exposes exactly these. */
export const IpcChannel = {
  Ping: "app:ping",
  ReposList: "repos:list",
  ReposAdd: "repos:add",
  ReposRemove: "repos:remove",
  AuditRun: "audit:run",
  AuditRecorded: "audit:recorded",
  AuthStatus: "auth:status",
  AuthSignIn: "auth:signIn",
  AuthSignOut: "auth:signOut",
  /** Push channel (main → renderer): sign-in progress after the device code. */
  AuthUpdate: "auth:update",
  ProfileLoad: "profile:load",
  ProfileSave: "profile:save",
  ProfileMeta: "profile:meta",
  SettingsLoad: "settings:load",
  SettingsSave: "settings:save",
  SettingsSetAnthropicKey: "settings:setAnthropicKey",
  UpdateCheck: "update:check",
  GatesStatus: "gates:status",
  GatesWaive: "gates:waive",
  GatesEvidence: "gates:evidence",
  PostureGet: "posture:get",
  PostureDraft: "posture:draft",
  ProjectGet: "project:get",
  ProjectRefresh: "project:refresh",
  ProjectDraft: "project:draft",
  /** Push channel (main → renderer): a repo's Project view, checked again. */
  ProjectUpdate: "project:update",
  HistoryGet: "history:get",
  HistoryOpenPr: "history:openPr",
  FixPlan: "fix:plan",
  FixApply: "fix:apply",
  FixOpenPr: "fix:openPr",
  AiTasks: "ai:tasks",
  AiRun: "ai:run",
  AiApply: "ai:apply",
  AiOpenPr: "ai:openPr",
  DocsList: "docs:list",
  DocsRead: "docs:read",
  FloorPlanGet: "floorplan:get",
  FloorPlanRun: "floorplan:run",
  /** Push channel (main → renderer): deep-audit swarm progress. */
  FloorPlanProgress: "floorplan:progress",
  TasksWatch: "tasks:watch",
  TasksUnwatch: "tasks:unwatch",
  TasksAnswer: "tasks:answer",
  TasksOpenPr: "tasks:openPr",
  TasksLedger: "tasks:ledger",
  TasksDetail: "tasks:detail",
  TasksPr: "tasks:pr",
  /** Push channel (main → renderer): the watched repo's tasks after a change. */
  TasksUpdate: "tasks:update",
  MapGet: "map:get",
  /** Push channel (main → renderer): requests the map's session cancelled. */
  MapBlocked: "map:blocked",
  NowGet: "now:get",
  NowSelect: "now:select",
  NowConfirm: "now:confirm",
  NowApprove: "now:approve",
  NowJudge: "now:judge",
  NowOpenPr: "now:openPr",
  NowHealth: "now:health",
  NowCi: "now:ci",
  NowBadges: "now:badges",
  /** Push channel (main → renderer): one repo's Now state after a change. */
  NowUpdate: "now:update",
  /** Push channel (main → renderer): how many items wait on you, per repo. */
  NowBadgesUpdate: "now:badgesUpdate",
  /** Push channel (main → renderer): a notification was clicked; show its item. */
  NowFocus: "now:focus",
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

// app:ping — a smoke round-trip proving the typed, validated bridge works.
export const PingResponse = z.object({
  reply: z.string(),
  version: z.string(),
});
export type PingResponse = z.infer<typeof PingResponse>;

export const PingRequest = z.object({ message: z.string().min(1).max(200) });
export type PingRequest = z.infer<typeof PingRequest>;

// Repos — local repo folders the user has added (persisted in userData).
export const RepoEntry = z.object({
  /** Absolute path to the repo on disk. */
  path: z.string(),
  /** Display name (folder basename). */
  name: z.string(),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export const RepoList = z.array(RepoEntry);
export type RepoList = z.infer<typeof RepoList>;

export const RepoRemoveRequest = z.object({ path: z.string().min(1) });
export type RepoRemoveRequest = z.infer<typeof RepoRemoveRequest>;

// Audit — the lane scorecard for one repo.
export const ControlStatus = z.enum([
  "pass",
  "fail",
  "skip",
  "needs-evidence",
  "waived",
  "n/a",
]);
export type ControlStatus = z.infer<typeof ControlStatus>;

const StatusCounts = z.object({
  pass: z.number().int(),
  fail: z.number().int(),
  needsEvidence: z.number().int(),
  waived: z.number().int(),
  skip: z.number().int(),
  na: z.number().int(),
});
export type StatusCounts = z.infer<typeof StatusCounts>;

export const ControlReference = z.object({
  name: z.string(),
  url: z.string(),
  section: z.string().optional(),
});

export const ScorecardControl = z.object({
  controlId: z.string(),
  title: z.string(),
  status: ControlStatus,
  severity: z.string(),
  message: z.string(),
  rationale: z.string(),
  references: z.array(ControlReference),
});
export type ScorecardControl = z.infer<typeof ScorecardControl>;

export const ScorecardLane = z.object({
  key: z.string(),
  title: z.string(),
  counts: StatusCounts,
  controls: z.array(ScorecardControl),
});
export type ScorecardLane = z.infer<typeof ScorecardLane>;

/** The audit recorded in `.rivetari/state.json`, shaped as lanes. */
export const Scorecard = z.object({
  repoPath: z.string(),
  /** ISO timestamp the audit was recorded; null if state.json doesn't say. */
  generatedAt: z.string().nullable(),
  totals: StatusCounts.extend({ total: z.number().int() }),
  lanes: z.array(ScorecardLane),
});
export type Scorecard = z.infer<typeof Scorecard>;

/** audit:run and audit:recorded both name just the repo. */
export const AuditRunRequest = z.object({ repoPath: z.string().min(1) });
export type AuditRunRequest = z.infer<typeof AuditRunRequest>;

// Auth — GitHub device-flow sign-in. The token lives in the main process
// (safeStorage) and never crosses IPC; the renderer only learns who is signed in.
export const AuthStatus = z.object({
  signedIn: z.boolean(),
  login: z.string().nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** auth:signIn response — what to show the user to complete the device flow. */
export const DeviceCodeInfo = z.object({
  userCode: z.string(),
  verificationUri: z.string(),
  expiresIn: z.number().int(),
});
export type DeviceCodeInfo = z.infer<typeof DeviceCodeInfo>;

/** auth:update push payload — the outcome of the background token poll. */
export const AuthUpdate = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-in"), login: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type AuthUpdate = z.infer<typeof AuthUpdate>;

// Profile — the form is driven by this metadata (the catalog's enum lists), so
// the renderer never imports the catalog (which pulls node:fs). The profile
// object itself is validated by the engine on load/save, not at this boundary.
const LabeledKey = z.object({ key: z.string(), title: z.string() });

export const ProfileMeta = z.object({
  types: z.array(z.string()),
  phases: z.array(LabeledKey),
  flags: z.array(z.string()),
  lanes: z.array(LabeledKey),
  severities: z.array(z.string()),
});
export type ProfileMeta = z.infer<typeof ProfileMeta>;

export const ProfileLoadRequest = z.object({ repoPath: z.string().min(1) });
export const ProfileSaveRequest = z.object({
  repoPath: z.string().min(1),
  profile: z.unknown(),
});

/**
 * Loose boundary check for profile:load / profile:save. The engine validates the
 * full profile schema on load/save; this only confirms the IPC boundary returned
 * an object (or null, for a repo with no profile) rather than something unexpected.
 * We can't validate the full schema here — the catalog's ProfileSchema pulls
 * node:fs, which the sandboxed preload can't import.
 */
export const ProfileResponse = z.record(z.string(), z.unknown()).nullable();

// Gates — the phase gates for a repo, the inferred phase, and what blocks each.
export const GateStatus = z.enum(["green", "amber", "red"]);
export type GateStatus = z.infer<typeof GateStatus>;

export const GateBlocker = z.object({
  controlId: z.string(),
  title: z.string(),
  status: z.enum(["fail", "needs-evidence"]),
  severity: z.string(),
});
export type GateBlocker = z.infer<typeof GateBlocker>;

export const GatePhase = z.object({
  phase: z.string(),
  title: z.string(),
  status: GateStatus.nullable(),
  /** The lowest phase whose gate isn't green, worked out from the controls. */
  inferred: z.boolean(),
  /** The phase the profile declares: the repo's current phase. */
  declared: z.boolean(),
  blockers: z.array(GateBlocker),
});
export type GatePhase = z.infer<typeof GatePhase>;

export const GatesReport = z.object({
  repoPath: z.string(),
  /** profile.yml's `phase`, or null when the profile doesn't declare one. */
  declaredPhase: z.string().nullable(),
  inferredPhase: z.string().nullable(),
  phases: z.array(GatePhase),
});
export type GatesReport = z.infer<typeof GatesReport>;

export const GatesStatusRequest = z.object({ repoPath: z.string().min(1) });

export const WaiveRequest = z.object({
  repoPath: z.string().min(1),
  control: z.string().min(1),
  reason: z.string().min(1),
  /** ISO date YYYY-MM-DD. */
  expires: z.string().min(1),
  owner: z.string().optional(),
});
export type WaiveRequest = z.infer<typeof WaiveRequest>;

export const EvidenceRequest = z.object({
  repoPath: z.string().min(1),
  control: z.string().min(1),
  url: z.string().optional(),
  note: z.string().optional(),
  reviewer: z.string().optional(),
  validFor: z.string().optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequest>;

// Posture — the scorecard and the phase lens over the one audit state.json
// records, the trend from history.jsonl, and the waivers and evidence on file.
export const PostureRequest = z.object({ repoPath: z.string().min(1) });

/** One snapshot from history.jsonl. fail and needsEvidence are null on rows that predate them. */
export const PostureTrendPoint = z.object({
  date: z.string(),
  pass: z.number().int(),
  fail: z.number().int().nullable(),
  needsEvidence: z.number().int().nullable(),
  total: z.number().int(),
});
export type PostureTrendPoint = z.infer<typeof PostureTrendPoint>;

export const PosturePhase = z.object({
  phase: z.string(),
  title: z.string(),
  status: GateStatus.nullable(),
});
export type PosturePhase = z.infer<typeof PosturePhase>;

export const PostureLens = z.object({
  /** profile.yml's phase: the repo's current phase. */
  declaredPhase: z.string().nullable(),
  /** The phase the recorded controls put the repo in, as `rivetari status` infers it. */
  inferredPhase: z.string().nullable(),
  allGreen: z.boolean(),
  /** The phase after the inferred one, or null at the last. */
  nextPhase: z.string().nullable(),
  phases: z.array(PosturePhase),
  /** What holds the inferred phase's gate shut, most severe first. */
  blockers: z.array(GateBlocker.extend({ effort: z.string() })),
});
export type PostureLens = z.infer<typeof PostureLens>;

/** active, or expiring within 30 days (the CLI's warning window), or past. */
export const ExpiryState = z.enum(["active", "expiring", "expired"]);
export type ExpiryState = z.infer<typeof ExpiryState>;

export const PostureWaiver = z.object({
  control: z.string(),
  title: z.string(),
  reason: z.string(),
  owner: z.string().nullable(),
  created: z.string().nullable(),
  expires: z.string(),
  state: ExpiryState,
});
export type PostureWaiver = z.infer<typeof PostureWaiver>;

export const PostureEvidence = z.object({
  control: z.string(),
  title: z.string(),
  reviewer: z.string().nullable(),
  date: z.string().nullable(),
  note: z.string().nullable(),
  url: z.string().nullable(),
  /** When it stops counting (YYYY-MM-DD), or null when it never expires. */
  expires: z.string().nullable(),
  state: ExpiryState,
});
export type PostureEvidence = z.infer<typeof PostureEvidence>;

export const Posture = z.object({
  repoPath: z.string(),
  /** The recorded audit; null before `rivetari audit` has recorded one. */
  scorecard: Scorecard.nullable(),
  lens: PostureLens.nullable(),
  trend: z.array(PostureTrendPoint),
  waivers: z.array(PostureWaiver),
  evidence: z.array(PostureEvidence),
  /** Why waivers.yml or evidence.yml couldn't be read, if one couldn't. */
  problems: z.array(z.string()),
});
export type Posture = z.infer<typeof Posture>;

// The catalog's control-id shape (CONTROL_ID_PATTERN), which the preload can't
// import: the catalog pulls node:fs.
const ControlId = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, "a control id");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** A card to draft through the runtime, for gaps, a waiver or evidence. */
export const PostureDraft = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gaps"),
    controls: z.array(ControlId).min(1).max(30),
  }),
  z.object({
    kind: z.literal("waive"),
    control: ControlId,
    reason: z.string().trim().min(1).max(500),
    expires: IsoDate,
  }),
  z.object({
    kind: z.literal("evidence"),
    control: ControlId,
    reason: z.string().trim().min(1).max(500),
    url: z
      .string()
      .trim()
      .max(500)
      .regex(/^https?:\/\/\S+$/, "a link that starts with http(s)://")
      .optional(),
  }),
]);
export type PostureDraft = z.infer<typeof PostureDraft>;

export const PostureDraftRequest = z.object({
  repoPath: z.string().min(1),
  draft: PostureDraft,
});
export type PostureDraftRequest = z.infer<typeof PostureDraftRequest>;

export const PostureDraftResult = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
  /** Set when the card is drafted here but pushing it to the tasks branch failed. */
  warning: z.string().nullable(),
});
export type PostureDraftResult = z.infer<typeof PostureDraftResult>;

// Project — profile.yml held against what the repo shows now, checked again by
// itself, beside the autonomy, proof, skills and banned patterns it records.
export const ProjectRequest = z.object({ repoPath: z.string().min(1) });

/** A profile.yml field, its value now, and the value the repo shows. */
export const ProjectChange = z.object({
  /** The field's path in profile.yml: `stack`, `phase`, `flags.uses-ai`. */
  path: z.string(),
  from: z.string(),
  to: z.string(),
});
export type ProjectChange = z.infer<typeof ProjectChange>;

export const ProjectField = z.object({
  /** Stable id for the row, which a draft names to pick it. */
  key: z.string(),
  label: z.string(),
  /** What profile.yml says, as shown; null when it says nothing. */
  declared: z.string().nullable(),
  /** What the repo shows now; null when nothing on disk says. */
  detected: z.string().nullable(),
  /** What shows it, or why nothing does. */
  evidence: z.string().nullable(),
  differs: z.boolean(),
  /** The change that brings profile.yml in line, when it differs. */
  change: ProjectChange.nullable(),
});
export type ProjectField = z.infer<typeof ProjectField>;

export const ProjectAutonomyEntry = z.object({
  level: z.string(),
  kind: z.string(),
  rules: z.number().int(),
  note: z.string(),
  at: z.string(),
  by: z.string(),
});
export type ProjectAutonomyEntry = z.infer<typeof ProjectAutonomyEntry>;

export const ProjectSkill = z.object({
  name: z.string(),
  source: z.string(),
  pin: z.string(),
  scope: z.enum(["always", "task"]),
  /** per-task: a task-scope skill, fetched when a route picks it. */
  state: z.enum([
    "installed",
    "per-task",
    "not-installed",
    "blocked",
    "modified",
  ]),
  detail: z.string().nullable(),
});
export type ProjectSkill = z.infer<typeof ProjectSkill>;

/** A sector a route found no skill for, with the router's reason. */
export const ProjectGap = z.object({
  sector: z.string().nullable(),
  reason: z.string(),
  /** The tasks whose routes hit it, newest first. */
  tasks: z.array(z.string()),
});
export type ProjectGap = z.infer<typeof ProjectGap>;

export const ProjectView = z.object({
  repoPath: z.string(),
  /** When the repo was last held against profile.yml (ISO). */
  checkedAt: z.string(),
  profileFound: z.boolean(),
  fields: z.array(ProjectField),
  /** Flags profile.yml sets that no file can show (has-users, eu-users, …). */
  otherFlags: z.array(z.string()),
  /** Why profile.yml can't be read now, read fresh with the records. */
  profileError: z.string().nullable(),
  /** An open task that already changes profile.yml, if there is one. */
  openTask: z.object({ id: z.string(), title: z.string() }).nullable(),
  autonomy: z.object({
    configured: z.string().nullable(),
    /** The autonomy ledger's entries, oldest first, once they verify. */
    entries: z.array(ProjectAutonomyEntry),
    problems: z.array(z.string()),
  }),
  /** profile.yml's proof block; null when it has none. */
  proof: z
    .object({
      start: z.string().nullable(),
      url: z.string().nullable(),
      readyTimeout: z.number().int().nullable(),
      /** Only whether sign-in is set up: the script is the person's. */
      auth: z.boolean(),
    })
    .nullable(),
  skills: z.object({
    locked: z.array(ProjectSkill),
    installed: z.number().int(),
    syncedAt: z.string().nullable(),
    /** What `rivetari skills status` says that no one skill explains. */
    problems: z.array(z.string()),
    gaps: z.array(ProjectGap),
    error: z.string().nullable(),
  }),
  banned: z.object({
    patterns: z.array(
      z.object({
        id: z.string(),
        pattern: z.string(),
        files: z.string(),
        why: z.string(),
        source: z.string(),
      }),
    ),
    error: z.string().nullable(),
  }),
  /** Why part of the view couldn't be read, if one couldn't. */
  problems: z.array(z.string()),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** Draft a card that brings these rows of profile.yml in line. */
export const ProjectDraftRequest = z.object({
  repoPath: z.string().min(1),
  keys: z.array(z.string().min(1).max(100)).min(1).max(30),
});
export type ProjectDraftRequest = z.infer<typeof ProjectDraftRequest>;

// Fix — proposed generator changes (dry-run or applied) and the PR outcome.
export const FixChange = z.object({
  controlId: z.string(),
  type: z.enum(["file", "effect", "note"]),
  action: z.enum([
    "create",
    "update",
    "skip",
    "unchanged",
    "suggest",
    "effect",
    "note",
  ]),
  path: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  message: z.string(),
  error: z.string().optional(),
});
export type FixChange = z.infer<typeof FixChange>;

export const FixPlan = z.object({
  changes: z.array(FixChange),
  generatorErrors: z.array(
    z.object({
      controlId: z.string(),
      fixType: z.string(),
      message: z.string(),
    }),
  ),
});
export type FixPlan = z.infer<typeof FixPlan>;

export const FixPrOutcome = z.object({
  pr: z
    .object({ number: z.number(), url: z.string(), reused: z.boolean() })
    .nullable(),
  commits: z.number().int(),
  pushed: z.boolean(),
  changeResults: z.array(FixChange),
  skippedEffects: z.number().int(),
});
export type FixPrOutcome = z.infer<typeof FixPrOutcome>;

export const FixPlanRequest = z.object({ repoPath: z.string().min(1) });

// AI — Claude-drafted artifacts (runs on the subscription CLI by default).
export const AiTaskInfo = z.object({ task: z.string(), output: z.string() });
export type AiTaskInfo = z.infer<typeof AiTaskInfo>;
export const AiTasks = z.array(AiTaskInfo);

export const AiRunResult = z.object({
  task: z.string(),
  outputPath: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** API-equivalent cost estimate (subscription runs aren't metered per token). */
  costUsd: z.number(),
  includedFiles: z.array(z.string()),
  truncated: z.boolean(),
  /** The drafted artifact (not yet written — apply or open a PR to persist it). */
  contents: z.string(),
});
export type AiRunResult = z.infer<typeof AiRunResult>;

export const AiRunRequest = z.object({
  repoPath: z.string().min(1),
  task: z.string().min(1),
});
export const AiApplyRequest = z.object({
  repoPath: z.string().min(1),
  task: z.string().min(1),
  outputPath: z.string().min(1),
  contents: z.string(),
});
export type AiApplyRequest = z.infer<typeof AiApplyRequest>;

export const AiApplyResult = z.object({
  action: z.string(),
  path: z.string(),
});

// Docs — Markdown files under docs/ and .rivetari/, rendered (with Mermaid).
export const DocEntry = z.object({ path: z.string(), name: z.string() });
export type DocEntry = z.infer<typeof DocEntry>;
export const DocList = z.array(DocEntry);

export const DocsListRequest = z.object({ repoPath: z.string().min(1) });
export const DocsReadRequest = z.object({
  repoPath: z.string().min(1),
  path: z.string().min(1),
});
export const DocContent = z.object({
  path: z.string(),
  markdown: z.string(),
});
export type DocContent = z.infer<typeof DocContent>;

// Floor Plan — the deep-audit swarm's repository model, drawn with Cytoscape. The
// model is produced by the engine swarm and persisted as managed state in
// `.rivetari/floorplan.json`; this boundary re-validates its full shape before the
// renderer draws it.
export const FloorPlanNodeKind = z.enum([
  "system",
  "subsystem",
  "feature",
  "service",
  "api",
  "connector",
  "datastore",
  "external",
  "package",
]);
export const FloorPlanEdgeKind = z.enum([
  "depends-on",
  "calls",
  "exposes",
  "reads",
  "writes",
  "imports",
  "deploys",
]);

export const FloorPlanNode = z.object({
  id: z.string(),
  kind: FloorPlanNodeKind,
  title: z.string(),
  summary: z.string(),
  paths: z.array(z.string()),
  tech: z.array(z.string()).optional(),
  parent: z.string().optional(),
  metrics: z
    .object({ files: z.number().optional(), loc: z.number().optional() })
    .optional(),
});
export type FloorPlanNode = z.infer<typeof FloorPlanNode>;

export const FloorPlanEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: FloorPlanEdgeKind,
  label: z.string().optional(),
});
export type FloorPlanEdge = z.infer<typeof FloorPlanEdge>;

export const DetectedProfile = z.object({
  type: z.string().optional(),
  stack: z.array(z.string()),
  flags: z.record(z.string(), z.boolean()),
  phase: z.string().optional(),
  confidence: z.number(),
});
export type DetectedProfile = z.infer<typeof DetectedProfile>;

export const SliceReport = z.object({
  key: z.string(),
  nodeIds: z.array(z.string()),
  note: z.string().optional(),
});

export const RepositoryModel = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  repoPath: z.string(),
  commit: z.string().optional(),
  summary: z.object({
    nodeCount: z.number().int(),
    edgeCount: z.number().int(),
    systemCount: z.number().int(),
    partial: z.boolean(),
  }),
  nodes: z.array(FloorPlanNode),
  edges: z.array(FloorPlanEdge),
  detected: DetectedProfile,
  slices: z.array(SliceReport),
});
export type RepositoryModel = z.infer<typeof RepositoryModel>;

/**
 * The get/run response: the persisted model (null if never built), whether the
 * deep-audit swarm can run at all (the Claude CLI must be installed), and whether
 * the persisted model is out of date for the repo's current HEAD.
 */
export const FloorPlanView = z.object({
  model: RepositoryModel.nullable(),
  deepAuditAvailable: z.boolean(),
  stale: z.boolean(),
});
export type FloorPlanView = z.infer<typeof FloorPlanView>;

export const FloorPlanGetRequest = z.object({ repoPath: z.string().min(1) });
export const FloorPlanRunRequest = z.object({ repoPath: z.string().min(1) });

/** floorplan:progress push payload — one step of the swarm. */
export const FloorPlanProgress = z.object({
  phase: z.enum(["slice", "map", "reduce", "done"]),
  message: z.string(),
  done: z.number().int(),
  total: z.number().int(),
});
export type FloorPlanProgress = z.infer<typeof FloorPlanProgress>;

// Tasks — a view of the repo's Rivetari tasks (the runtime's watchTasks), as
// `rivetari task status` would show them. The person can answer a stop and open
// a task's PR from it; running, approving and closing stay with the CLI.
export const TaskEntry = z.object({
  seq: z.number().int(),
  at: z.string(),
  beat: z.string(),
  section: z.string(),
  text: z.string(),
  by: z.string(),
});
export type TaskEntry = z.infer<typeof TaskEntry>;

export const TaskNeedsYou = z.object({
  kind: z.enum(["record", "stop", "judge", "intake", "route"]),
  why: z.string(),
});
export type TaskNeedsYou = z.infer<typeof TaskNeedsYou>;

export const TaskSummary = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  risk: z.string(),
  owner: z.string(),
  beat: z.string(),
  next: z.string(),
  done: z.boolean(),
  source: z.enum(["branch", "local"]),
  lease: z.object({ holder: z.string(), expires: z.string() }).nullable(),
  buildRounds: z.number().int(),
  judgeRounds: z.number().int(),
  tokens: z.number(),
  costUsd: z.number(),
  pr: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  needsYou: TaskNeedsYou.nullable(),
  problems: z.array(z.string()),
  /**
   * The seq of the ledger's last entry. The ledger itself isn't in the list:
   * it's fetched (tasks:ledger) for the task that's open, again when this moves.
   */
  ledgerSeq: z.number().int(),
  /** What it waits on a person for, as the Now view's queue says it; a PR to merge too. */
  waiting: z
    .enum(["intake", "route", "stop", "judge", "merge", "record"])
    .nullable(),
  /** The beat running now, from its progress file; null when none is. */
  progress: z
    .object({
      beat: z.string(),
      startedAt: z.string(),
      lastActivityAt: z.string(),
      turns: z.number().int().optional(),
      tokens: z.number().optional(),
      lastTool: z.string().optional(),
    })
    .nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;
export type TaskProgress = NonNullable<TaskSummary["progress"]>;

/** The watched repo's tasks, as a whole each time, plus the latest read error. */
export const TasksState = z.object({
  repoPath: z.string(),
  tasks: z.array(TaskSummary),
  error: z.string().nullable(),
});
export type TasksState = z.infer<typeof TasksState>;

export const TasksWatchRequest = z.object({ repoPath: z.string().min(1) });

// Map — the floorplan skill's static map (floorplan/index.html), shown in a
// webview whose session cancels every request outside floorplan/.

/** The map webview's session, which main guards; the renderer's webview names it. */
export const MAP_PARTITION = "rivetari-map";

export const MapGetRequest = z.object({ repoPath: z.string().min(1) });

export const MapView = z.object({
  repoPath: z.string(),
  /** The repo's floorplan/ directory, whether or not a map is in it. */
  dir: z.string(),
  /** file:// URL of floorplan/index.html, or null when there's no map yet. */
  url: z.string().nullable(),
  /** The profile's `floorplan` switch. */
  floorplanOn: z.boolean(),
});
export type MapView = z.infer<typeof MapView>;

/** map:blocked push payload — every request cancelled since the map was opened. */
export const MapBlocked = z.object({
  repoPath: z.string(),
  urls: z.array(z.string()),
});
export type MapBlocked = z.infer<typeof MapBlocked>;

/** tasks:answer — allow or deny a task's open stops, with an optional note. */
export const TaskAnswerRequest = z.object({
  id: z.string().regex(/^T-\d{4,}$/),
  allow: z.boolean(),
  note: z.string().max(2000),
});
export type TaskAnswerRequest = z.infer<typeof TaskAnswerRequest>;

export const TaskAnswerIpcRequest = TaskAnswerRequest.extend({
  repoPath: z.string().min(1),
});

/** What the answer recorded; `warning` is set when only its push failed. */
export const TaskAnswerResult = z.object({
  id: z.string(),
  answer: z.enum(["allowed", "denied"]),
  by: z.string(),
  next: z.string(),
  warning: z.string().nullable(),
});
export type TaskAnswerResult = z.infer<typeof TaskAnswerResult>;

/** tasks:openPr — open the task's PR (the URL its ledger records) in the browser. */
export const TaskOpenPrRequest = z.object({
  repoPath: z.string().min(1),
  id: z.string().regex(/^T-\d{4,}$/),
});
export const TaskOpenPrResult = z.object({ url: z.string() });
export type TaskOpenPrResult = z.infer<typeof TaskOpenPrResult>;

/** tasks:ledger — the open task's ledger entries, as the watcher last read them. */
export const TaskLedgerRequest = z.object({
  repoPath: z.string().min(1),
  id: z.string().regex(/^T-\d{4,}$/),
});
export const TaskLedger = z.array(TaskEntry);

// Now — a repo's living reflection: what's running, everything that waits on a
// person, what just happened, and how healthy the repo is. The main process
// watches every repo in the sidebar while the window is open, so the queue and
// the badges stay current whichever tab is on show. All of it is read from
// the runtime's records; the only writes are confirm, approve and answer.
const TaskId = z.string().regex(/^T-\d{4,}$/);
const PrLink = z.object({ number: z.number().int(), url: z.string() });

/** A task with a beat running on this machine now. */
export const NowRunning = z.object({
  id: z.string(),
  title: z.string(),
  beat: z.string(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  turns: z.number().int().optional(),
  lastTool: z.string().optional(),
  costUsd: z.number(),
});
export type NowRunning = z.infer<typeof NowRunning>;

/** The card as recorded, for the person confirming it. */
export const NowCard = z.object({
  type: z.string(),
  risk: z.string(),
  description: z.string(),
  acceptance: z.array(
    z.object({ id: z.string(), text: z.string(), verify: z.string() }),
  ),
  outOfScope: z.array(z.string()),
  touches: z.array(z.string()),
});
export type NowCard = z.infer<typeof NowCard>;

/** assembly.yml as proposed, for the person approving the route. */
export const NowAssembly = z.object({
  sectors: z.array(z.string()),
  skills: z.array(z.string()),
  spine: z.array(z.string()),
  gaps: z.array(z.string()),
  checks: z.array(z.string()),
  proof: z.string(),
  budget: z.object({
    skillTokens: z.number(),
    contextTokens: z.number(),
    steps: z.number(),
  }),
  stopAndAsk: z.array(z.string()),
  review: z.object({ designPass: z.boolean(), security: z.boolean() }),
});
export type NowAssembly = z.infer<typeof NowAssembly>;

const NeedsBase = {
  id: z.string(),
  title: z.string(),
  why: z.string(),
  /** What happens next, as the runtime says it. */
  next: z.string(),
  pr: PrLink.nullable(),
  ledgerSeq: z.number().int(),
};

/**
 * One thing waiting on a person. `shown` on intake and route is the digest of
 * what was put in front of them; the action is refused if it changed since.
 */
export const NeedsYouItem = z.discriminatedUnion("kind", [
  z.object({
    ...NeedsBase,
    kind: z.literal("intake"),
    card: NowCard,
    shown: z.string(),
  }),
  z.object({
    ...NeedsBase,
    kind: z.literal("route"),
    /** Null when assembly.yml can't be read as one; `problems` says why. */
    assembly: NowAssembly.nullable(),
    problems: z.array(z.string()),
    /** The router's reasons, from the route beat's ledger entries. */
    reasons: z.array(z.string()),
    shown: z.string(),
  }),
  z.object({ ...NeedsBase, kind: z.literal("stop") }),
  z.object({ ...NeedsBase, kind: z.literal("judge") }),
  z.object({ ...NeedsBase, kind: z.literal("merge") }),
  z.object({ ...NeedsBase, kind: z.literal("record") }),
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;
export type NeedsYouKind = NeedsYouItem["kind"];

export const RecentKind = z.enum([
  "merged",
  "closed",
  "abandoned",
  "judged",
  "stopped",
  "answered",
  "shipped",
]);
export type RecentKind = z.infer<typeof RecentKind>;

/** A ledger event worth seeing in the feed. */
export const RecentEvent = z.object({
  id: z.string(),
  title: z.string(),
  seq: z.number().int(),
  at: z.string(),
  kind: RecentKind,
  text: z.string(),
  by: z.string(),
});
export type RecentEvent = z.infer<typeof RecentEvent>;

export const NowState = z.object({
  repoPath: z.string(),
  /** The first read has landed. */
  ready: z.boolean(),
  taskCount: z.number().int(),
  running: z.array(NowRunning),
  needsYou: z.array(NeedsYouItem),
  recent: z.array(RecentEvent),
  /** What the open tasks have cost so far, from their ledgers. */
  openCostUsd: z.number(),
  error: z.string().nullable(),
});
export type NowState = z.infer<typeof NowState>;

export const NowRepoRequest = z.object({ repoPath: z.string().min(1) });
export const NowSelectRequest = z.object({
  repoPath: z.string().min(1).nullable(),
});
export const NowTaskRequest = z.object({
  repoPath: z.string().min(1),
  id: TaskId,
});
export const NowActionRequest = NowTaskRequest.extend({
  shown: z.string().min(1),
});
export type NowActionRequest = z.infer<typeof NowActionRequest>;

/** What a confirm or approve recorded; `warning` is set when only its push failed. */
export const NowActionResult = z.object({
  id: z.string(),
  by: z.string(),
  next: z.string(),
  warning: z.string().nullable(),
});
export type NowActionResult = z.infer<typeof NowActionResult>;

export const NowFinding = z.object({
  kind: z.string(),
  title: z.string(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  detail: z.string().nullable(),
});
export type NowFinding = z.infer<typeof NowFinding>;

/** The judge's latest round, as sealed in the ledger; null before any verdict. */
export const NowJudge = z
  .object({
    round: z.number().int(),
    verdict: z.string(),
    blocking: z.array(NowFinding),
    suggestions: z.array(NowFinding),
    /** Acceptance criteria the review didn't find met. */
    acceptance: z.array(
      z.object({ id: z.string(), status: z.string(), note: z.string() }),
    ),
    protectedPaths: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .nullable();
export type NowJudge = z.infer<typeof NowJudge>;

export const NowHealth = z.object({
  repoPath: z.string(),
  /** The profile's autonomy level; null when the repo has no profile. */
  autonomy: z.object({
    configured: z.string().nullable(),
    error: z.string().nullable(),
  }),
  spend: z.object({
    todayUsd: z.number(),
    weekUsd: z.number(),
    openUsd: z.number(),
    error: z.string().nullable(),
  }),
  skills: z.object({
    locked: z.number().int(),
    installed: z.number().int(),
    /** What `rivetari skills status` would complain about. */
    problems: z.array(z.string()),
    /** Sectors the open tasks' routes found no skill for. */
    gaps: z.array(z.string()),
    error: z.string().nullable(),
  }),
});
export type NowHealth = z.infer<typeof NowHealth>;

/** main's CI on GitHub, or why it isn't shown. */
export const NowCi = z.object({
  state: z.enum([
    "signed-out",
    "unavailable",
    "passing",
    "failing",
    "running",
    "none",
  ]),
  branch: z.string().nullable(),
  url: z.string().nullable(),
  detail: z.string(),
});
export type NowCi = z.infer<typeof NowCi>;

export const NowBadges = z.array(
  z.object({ repoPath: z.string(), count: z.number().int() }),
);
export type NowBadges = z.infer<typeof NowBadges>;

/** now:focus push payload — the item a clicked notification was about. */
export const NowFocus = z.object({ repoPath: z.string(), id: z.string() });
export type NowFocus = z.infer<typeof NowFocus>;

// Task detail — one task in full: the card with each criterion's status from
// the latest judge round, the route, the plan, the proof, every judge round
// and the PR's live state on GitHub. Read from the records (the watcher's view,
// and this machine's judge and proof files); nothing here writes.

export const TaskRequest = z.object({
  repoPath: z.string().min(1),
  id: TaskId,
});

/** How a criterion stands after the latest judge round. */
export const CriterionStatus = z.enum([
  "met",
  "unmet",
  "unverified",
  "hand-checked",
  "not judged",
]);
export type CriterionStatus = z.infer<typeof CriterionStatus>;

export const TaskCriterion = z.object({
  id: z.string(),
  text: z.string(),
  verify: z.string(),
  status: CriterionStatus,
  /** The reviewer's note, or who checked it by hand. */
  note: z.string(),
});
export type TaskCriterion = z.infer<typeof TaskCriterion>;

export const TaskFinding = z.object({
  kind: z.string(),
  title: z.string(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  acceptanceId: z.string().nullable(),
  detail: z.string(),
  repro: z.string(),
  fix: z.string(),
  /** Set when a blocking finding was turned into a suggestion, and why. */
  downgraded: z.string().nullable(),
});
export type TaskFinding = z.infer<typeof TaskFinding>;

export const TaskJudgeRound = z.object({
  round: z.number().int(),
  verdict: z.string(),
  at: z.string(),
  /** Why the round's record can't be shown; null when it verified. */
  problem: z.string().nullable(),
  head: z.string().nullable(),
  tier1: z
    .object({
      verdict: z.string(),
      checks: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          outcome: z.string(),
          message: z.string(),
        }),
      ),
      protectedPaths: z.array(z.string()),
      notes: z.array(z.string()),
    })
    .nullable(),
  /** Null when tier 1 didn't leave the decision to the review. */
  review: z
    .object({
      verdict: z.string(),
      model: z.string(),
      blocking: z.array(TaskFinding),
      suggestions: z.array(TaskFinding),
      acceptance: z.array(
        z.object({ id: z.string(), status: z.string(), note: z.string() }),
      ),
      unreviewed: z.array(z.string()),
    })
    .nullable(),
  risk: z
    .object({
      card: z.string(),
      effective: z.string(),
      reasons: z.array(z.string()),
    })
    .nullable(),
});
export type TaskJudgeRound = z.infer<typeof TaskJudgeRound>;

export const TaskProofShot = z.object({
  side: z.string(),
  page: z.string(),
  breakpoint: z.string(),
  /** The page's HTTP status when it was shot. */
  status: z.number(),
  file: z.string(),
  bytes: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** The PNG as a data: URL (the page's CSP allows no other image source). */
  dataUrl: z.string().nullable(),
  problem: z.string().nullable(),
});
export type TaskProofShot = z.infer<typeof TaskProofShot>;

export const TaskProof = z.object({
  kind: z.string(),
  passed: z.boolean(),
  lines: z.array(z.string()),
  tests: z
    .object({
      exitCode: z.number(),
      added: z.array(z.string()),
      outcome: z.string().nullable(),
    })
    .nullable(),
  violations: z.array(
    z.object({
      id: z.string(),
      impact: z.string(),
      page: z.string(),
      nodes: z.number(),
    }),
  ),
  shots: z.array(TaskProofShot),
  /** test-run.txt, its tail when it's long; null when there's none. */
  testRun: z.string().nullable(),
  /** A UI screenshot proof, which carries the R-25 warning. */
  ui: z.boolean(),
});
export type TaskProof = z.infer<typeof TaskProof>;

export const TaskDetail = z.object({
  id: z.string(),
  title: z.string(),
  /** Null when the card couldn't be read from the record. */
  card: z
    .object({
      description: z.string(),
      type: z.string(),
      risk: z.string(),
      outOfScope: z.array(z.string()),
      touches: z.array(z.string()),
      acceptance: z.array(TaskCriterion),
    })
    .nullable(),
  /** The judge round the criteria's statuses come from. */
  judgedRound: z.number().int().nullable(),
  /** Null before the card has been routed. */
  route: z
    .object({
      assembly: NowAssembly.nullable(),
      problems: z.array(z.string()),
      reasons: z.array(z.string()),
      approved: z.boolean(),
    })
    .nullable(),
  plan: z.array(z.string()),
  judge: z.object({
    rounds: z.array(TaskJudgeRound),
    error: z.string().nullable(),
  }),
  proof: z.object({
    /** Null before the prove beat has written proof.json on this machine. */
    record: TaskProof.nullable(),
    error: z.string().nullable(),
  }),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/** A task's PR on GitHub, live, or why it isn't shown. */
export const TaskPrState = z.object({
  state: z.enum([
    "signed-out",
    "unavailable",
    "none",
    "open",
    "merged",
    "closed",
  ]),
  number: z.number().int().nullable(),
  draft: z.boolean().nullable(),
  /** GitHub's own answer, null while it's still working it out. */
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().nullable(),
  headSha: z.string().nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      headSha: z.string(),
    }),
  ),
  detail: z.string(),
});
export type TaskPrState = z.infer<typeof TaskPrState>;

// Settings — personal preferences in `userData` (never the repo). The Anthropic
// API key is NOT in this object: like the GitHub token it lives in safeStorage and
// never crosses IPC — the renderer only learns whether one is set.
export const Theme = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;

export const Settings = z.object({
  /** UI theme; "system" follows the OS preference. */
  theme: Theme,
  /** Force the metered Anthropic API over the Claude CLI for AI tasks. */
  aiPreferApiKey: z.boolean(),
  /** Check for a newer release on launch. */
  autoCheckUpdates: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

/** What the renderer sees: the settings plus whether an Anthropic key is stored. */
export const SettingsView = Settings.extend({
  anthropicKeySet: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsView>;

/** A partial update — only the provided fields change. */
export const SettingsSaveRequest = Settings.partial();
export type SettingsSaveRequest = z.infer<typeof SettingsSaveRequest>;

/** Set (non-empty) or clear (empty string) the stored Anthropic key. */
export const AnthropicKeyRequest = z.object({ key: z.string() });
export type AnthropicKeyRequest = z.infer<typeof AnthropicKeyRequest>;

// History — closed tasks with what they cost, the judge's findings and the
// cost flags, read from the same records `rivetari metrics` reads.
export const HistoryRequest = z.object({ repoPath: z.string().min(1) });
export type HistoryRequest = z.infer<typeof HistoryRequest>;

export const ClosedTaskItem = z.object({
  id: z.string(),
  title: z.string().nullable(),
  outcome: z.enum(["merged", "closed", "abandoned"]),
  pr: z.number().int().nullable(),
  costUsd: z.number(),
  tokens: z.number(),
  buildRounds: z.number().int(),
  judgeRounds: z.number().int(),
  retryRounds: z.number().int().nullable(),
  minutes: z.number(),
  risk: z.string().nullable(),
  skills: z.array(z.string()),
  closedAt: z.string(),
  cardToPrMinutes: z.number().nullable(),
  judgeCostUsd: z.number().nullable(),
  ledgerProblem: z.string().nullable(),
});
export type ClosedTaskItem = z.infer<typeof ClosedTaskItem>;

export const SpendDay = z.object({
  date: z.string(),
  merged: z.number().int(),
  mergedUsd: z.number(),
  abandonedUsd: z.number(),
  closedUsd: z.number(),
});
export type SpendDay = z.infer<typeof SpendDay>;

export const TaskMetricsSummary = z.object({
  tasks: z.number().int(),
  merged: z.number().int(),
  abandoned: z.number().int(),
  closed: z.number().int(),
  spend: z.object({
    totalUsd: z.number(),
    mergedUsd: z.number(),
    abandonedUsd: z.number(),
    closedUsd: z.number(),
    perMergedUsd: z.number().nullable(),
    mergedMedianUsd: z.number().nullable(),
    abandonedShare: z.number().nullable(),
  }),
  judge: z.object({
    costUsd: z.number(),
    share: z.number().nullable(),
    tasks: z.number().int(),
  }),
  rounds: z.object({
    build: z.number().int(),
    judge: z.number().int(),
    retries: z.number().int(),
    retryShare: z.number().nullable(),
    multiBuild: z.number().int(),
  }),
  cardToPr: z.object({
    medianMinutes: z.number().nullable(),
    tasks: z.number().int(),
  }),
  trend: z.array(SpendDay),
});
export type TaskMetricsSummary = z.infer<typeof TaskMetricsSummary>;

export const HistoryPattern = z.object({
  pattern: z.string(),
  kind: z.string(),
  title: z.string(),
  prs: z.array(z.string()),
});
export type HistoryPattern = z.infer<typeof HistoryPattern>;

export const HistoryFindings = z.object({
  reviewed: z.number().int(),
  findings: z.number().int(),
  blocking: z.number().int(),
  suggestions: z.number().int(),
  findingsPerPr: z.number().nullable(),
  tier1Rules: z.object({
    catalog: z.number().int(),
    diff: z.number().int(),
    total: z.number().int(),
  }),
  patterns: z.array(HistoryPattern),
  candidates: z.array(HistoryPattern),
});
export type HistoryFindings = z.infer<typeof HistoryFindings>;

export const HistoryCostFlag = z.object({
  task: z.string(),
  costUsd: z.number(),
  promptTokens: z.number().nullable(),
});
export type HistoryCostFlag = z.infer<typeof HistoryCostFlag>;

export const HistoryView = z.object({
  repoPath: z.string(),
  summary: TaskMetricsSummary,
  /** Newest first. */
  tasks: z.array(ClosedTaskItem),
  findings: HistoryFindings,
  /** Low-risk tasks over $1, as `rivetari metrics` flags them. */
  costFlags: z.array(HistoryCostFlag),
  /** Why part of the view couldn't be read, if one couldn't. */
  problems: z.array(z.string()),
});
export type HistoryView = z.infer<typeof HistoryView>;

export const HistoryOpenPrRequest = z.object({
  repoPath: z.string().min(1),
  id: z.string().min(1),
});
export type HistoryOpenPrRequest = z.infer<typeof HistoryOpenPrRequest>;

// Update check — queries the GitHub Releases API with the user's token (ADR-0010
// private-repo path), so it works for a private release repo electron-updater can't.
export const UpdateInfo = z.object({
  currentVersion: z.string(),
  /** The latest published release's version, or null if none / unreachable. */
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** The release (or download) page to open; null when there's no release. */
  url: z.string().nullable(),
  /** ISO publish date of the latest release, when known. */
  publishedAt: z.string().nullable(),
  /** Set when GitHub wouldn't list releases to someone signed out. */
  signInNeeded: z.boolean().optional(),
});
export type UpdateInfo = z.infer<typeof UpdateInfo>;
