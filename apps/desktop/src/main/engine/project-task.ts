// The Project view's one write: drafting a card that brings profile.yml in
// line with the repo. profile.yml is a protected path, so the shell never
// writes it; it drafts a card through the runtime the way Posture does (check
// the card, reserve an id on the tasks branch, newTask, push) and leaves it at
// intake for a person to confirm. The repo is checked again here rather than
// trusting the rows the renderer last showed, so the card names only what
// still differs.
import {
  type CardInput,
  commitTask,
  holderName,
  newTask,
  parseCard,
  reserveTaskId,
  whoami,
} from "@arynbht/rivetari-runtime";

import type { PostureDraftResult, ProjectField } from "../../shared/ipc";
import { checkProject, PROFILE_PATH } from "./project";
import { plain } from "./task-beat";

type DraftInput = Omit<CardInput, "id" | "created" | "owner">;

const PROTECTED =
  "is a protected path, so the judge hands this change to a person before it can merge";

export interface ProfileCardContext {
  /** When the repo was checked (ISO). */
  checkedAt: string;
  by: string;
}

/**
 * The card for these rows of the check: each change from → to, one
 * acceptance criterion per field. Throws a message the person can act on when
 * a row picked no longer differs, or none is picked.
 */
export function profileCard(
  fields: ProjectField[],
  keys: string[],
  ctx: ProfileCardContext,
): DraftInput {
  const picked = [...new Set(keys)].map((key) => {
    const field = fields.find((f) => f.key === key);
    if (!field) throw new Error(`${key} isn't a profile field Rivetari checks`);
    if (!field.change)
      throw new Error(
        `${field.label} matches the repo now, so there's nothing to update; check again and pick from what differs`,
      );
    return { field, change: field.change };
  });
  if (picked.length === 0)
    throw new Error("pick at least one field that differs from the repo");
  const paths = picked.map((p) => p.change.path);
  return {
    title:
      picked.length === 1
        ? `Update profile.yml: ${paths[0]}`
        : `Bring profile.yml up to date: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`,
    type: "chore",
    source: "desktop project",
    description: [
      `${PROFILE_PATH} no longer matches what the repo shows, as the desktop's Project view checked it at ${ctx.checkedAt.slice(0, 16).replace("T", " ")} UTC:`,
      ...picked.map(
        ({ field, change }) =>
          `- ${change.path}: ${change.from} → ${change.to}${field.evidence ? ` (${field.evidence})` : ""}`,
      ),
      "",
      `Change these fields and nothing else. Picked from the desktop's Project view by ${ctx.by}.`,
    ].join("\n"),
    acceptance: picked.map(({ change }, i) => ({
      id: `A${i + 1}`,
      text: `${PROFILE_PATH} sets ${change.path} to ${change.to} (it was ${change.from})`,
      verify: "review" as const,
    })),
    out_of_scope: [`any other field of ${PROFILE_PATH}`],
    touches: [PROFILE_PATH],
    constraints: [`${PROFILE_PATH} ${PROTECTED}`],
  };
}

/** The runtime calls a draft makes; a test hands in its own. */
export interface ProfileDraftDeps {
  whoami: typeof whoami;
  checkProject: typeof checkProject;
  reserveTaskId: typeof reserveTaskId;
  newTask: typeof newTask;
  commitTask: typeof commitTask;
}

const draftDeps: ProfileDraftDeps = {
  whoami,
  checkProject,
  reserveTaskId,
  newTask,
  commitTask,
};

/** Draft a card for the picked rows through the runtime, as `task new` does. */
export async function draftProfileTask(
  repoPath: string,
  keys: string[],
  deps: ProfileDraftDeps = draftDeps,
): Promise<PostureDraftResult> {
  try {
    const check = await deps.checkProject(repoPath);
    if (!check.profileFound)
      throw new Error(
        `there's no readable ${PROFILE_PATH} to update; ${check.problems[0] ?? "run `rivetari init`"}`,
      );
    const by = await deps.whoami(repoPath);
    const input = profileCard(check.fields, keys, {
      checkedAt: check.checkedAt,
      by,
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
