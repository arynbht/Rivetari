// Posture's one kind of write: drafting a task card. Closing gaps, adding a
// waiver and attaching evidence all change the repo, and waivers.yml and
// evidence.yml are protected paths, so the shell never writes them itself. It
// drafts a card through the runtime the way `rivetari task new` does (check the
// card, reserve an id on the tasks branch, newTask, push), and the change then
// goes through the beats to a reviewed PR. The card is left at intake for a
// person to confirm: advancing it would route it, which can call a model and
// cost money, and nothing in the shell spends money without its own click.
import {
  type CardInput,
  commitTask,
  holderName,
  newTask,
  parseCard,
  reserveTaskId,
  whoami,
} from "@arynbht/rivetari-runtime";
import {
  readRecordedAudit,
  type RecordedControl,
} from "@arynbht/rivetari-engine";

import type { PostureDraft, PostureDraftResult } from "../../shared/ipc";
import { bundledControls } from "./audit";
import { plain } from "./task-beat";

type DraftInput = Omit<CardInput, "id" | "created" | "owner">;

const AUDIT = "`rivetari audit`";
const PROTECTED =
  "is a protected path, so the judge hands this change to a person before it can merge";

const failing = (c: RecordedControl) =>
  c.status === "fail" || c.status === "needs-evidence";

const statusWord = (c: RecordedControl) =>
  c.status === "needs-evidence" ? "needs evidence" : c.status;

export interface DraftContext {
  /** The recorded result of each control the draft names, by id. */
  recorded: Map<string, RecordedControl>;
  titles: Map<string, string>;
  /** When state.json recorded the audit, if it says. */
  generatedAt: string | null;
  by: string;
  /** Today, YYYY-MM-DD: a waiver has to run past it. */
  today: string;
}

/**
 * The card for a draft, checked against the recorded audit: a gap or a waiver
 * has to name a control that doesn't pass there, and evidence a control the
 * audit knows. Throws a message the person can act on otherwise.
 */
export function postureCard(
  draft: PostureDraft,
  ctx: DraftContext,
): DraftInput {
  const named = draft.kind === "gaps" ? draft.controls : [draft.control];
  for (const id of named) {
    const result = ctx.recorded.get(id);
    if (!result)
      throw new Error(
        `${id} isn't in the recorded audit; run ${AUDIT} and look again`,
      );
    if (draft.kind !== "evidence" && !failing(result))
      throw new Error(
        `${id} is ${result.status} in the recorded audit, so there's nothing to ${draft.kind === "gaps" ? "fix" : "waive"}`,
      );
  }
  // A waiver that has already lapsed would draft a task that changes nothing.
  if (draft.kind === "waive" && draft.expires <= ctx.today)
    throw new Error(
      `a waiver has to run past today (${ctx.today}); pick a later date than ${draft.expires}`,
    );
  const title = (id: string) => ctx.titles.get(id) ?? id;
  const recordedAt = ctx.generatedAt
    ? `the audit recorded ${ctx.generatedAt.slice(0, 10)}`
    : "the recorded audit";

  if (draft.kind === "gaps") {
    const ids = [...new Set(draft.controls)];
    const shown = ids.slice(0, 3).join(", ");
    return {
      title:
        ids.length === 1
          ? `Make ${ids[0]} pass`
          : `Close posture gaps: ${shown}${ids.length > 3 ? ` and ${ids.length - 3} more` : ""}`,
      type: "fix",
      source: "desktop posture",
      description: [
        `These controls don't pass in ${recordedAt} (.rivetari/state.json):`,
        ...ids.map((id) => {
          const result = ctx.recorded.get(id);
          return `- ${id}: ${title(id)} (${result ? statusWord(result) : "unknown"})`;
        }),
        "",
        `Make each one pass in ${AUDIT} by changing what it checks. Picked from the desktop's Posture view by ${ctx.by}.`,
      ].join("\n"),
      acceptance: ids.map((id, i) => ({
        id: `A${i + 1}`,
        text: `${id} passes in ${AUDIT}`,
        verify: "review" as const,
      })),
      out_of_scope: [
        "waiving, skipping or marking n/a any of these controls instead of fixing it",
      ],
    };
  }

  const id = draft.control;
  if (draft.kind === "waive") {
    return {
      title: `Waive ${id}`,
      type: "chore",
      source: "desktop posture",
      description: [
        `Add a waiver for ${id} (${title(id)}) to .rivetari/waivers.yml.`,
        "",
        `Reason: ${draft.reason}`,
        `Expires: ${draft.expires}`,
        "",
        `Asked for from the desktop's Posture view by ${ctx.by}.`,
      ].join("\n"),
      acceptance: [
        {
          id: "A1",
          text: `.rivetari/waivers.yml waives ${id} until ${draft.expires} with the reason given, an owner and the date it was added`,
          verify: "review",
        },
        {
          id: "A2",
          text: `${id} shows as waived in ${AUDIT}`,
          verify: "review",
        },
      ],
      touches: [".rivetari/waivers.yml"],
      constraints: [`.rivetari/waivers.yml ${PROTECTED}`],
    };
  }

  return {
    title: `Attach evidence for ${id}`,
    type: "chore",
    source: "desktop posture",
    description: [
      `Record evidence for ${id} (${title(id)}) in .rivetari/evidence.yml.`,
      "",
      `What it shows: ${draft.reason}`,
      ...(draft.url ? [`Link: ${draft.url}`] : []),
      "",
      `Asked for from the desktop's Posture view by ${ctx.by}.`,
    ].join("\n"),
    acceptance: [
      {
        id: "A1",
        text: `.rivetari/evidence.yml has a dated entry for ${id} naming its reviewer${draft.url ? ` and linking ${draft.url}` : ""}`,
        verify: "review",
      },
      { id: "A2", text: `${id} passes in ${AUDIT}`, verify: "review" },
    ],
    touches: [".rivetari/evidence.yml"],
    constraints: [`.rivetari/evidence.yml ${PROTECTED}`],
  };
}

/** The runtime calls a draft makes; a test hands in its own. */
export interface DraftDeps {
  whoami: typeof whoami;
  readRecordedAudit: typeof readRecordedAudit;
  bundledControls: typeof bundledControls;
  reserveTaskId: typeof reserveTaskId;
  newTask: typeof newTask;
  commitTask: typeof commitTask;
}

const draftDeps: DraftDeps = {
  whoami,
  readRecordedAudit,
  bundledControls,
  reserveTaskId,
  newTask,
  commitTask,
};

/** Draft a card for `draft` through the runtime, as `rivetari task new` does. */
export async function draftPostureTask(
  repoPath: string,
  draft: PostureDraft,
  deps: DraftDeps = draftDeps,
): Promise<PostureDraftResult> {
  try {
    const recorded = await deps.readRecordedAudit(repoPath);
    if (!recorded)
      throw new Error(
        `no audit is recorded in .rivetari/state.json yet; run ${AUDIT} first`,
      );
    const by = await deps.whoami(repoPath);
    const input = postureCard(draft, {
      recorded: new Map(recorded.controls.map((c) => [c.id, c])),
      titles: new Map(
        (await deps.bundledControls()).map((c) => [c.id, c.title]),
      ),
      generatedAt: recorded.generatedAt,
      by,
      today: new Date().toISOString().slice(0, 10),
    });
    // Refuse a bad card before an id is reserved for it on the branch.
    parseCard({ ...input, id: "T-0000", owner: by, created: "2000-01-01" });
    const holder = holderName(by);
    const id = await deps.reserveTaskId(repoPath, { holder });
    const task = await deps.newTask(repoPath, input, { by, id });
    let warning: string | null = null;
    try {
      await deps.commitTask(repoPath, id, {
        holder,
        message: `${id}: drafted`,
      });
    } catch (err) {
      warning = `the card is drafted, but pushing it failed: ${plain(err).message}. It's kept on this machine; the next beat on ${id} pushes it.`;
    }
    return { id, title: task.card.title, by, warning };
  } catch (err) {
    throw plain(err);
  }
}
