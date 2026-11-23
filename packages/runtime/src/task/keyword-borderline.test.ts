import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { route } from "../router/route.js";
import { type RouteContext, routeTask } from "../router/task-route.js";
import { advanceTask } from "./autonomy.js";
import { parseCard } from "./card.js";
import { confirmTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoAtReviewAtPr(
  extra: Record<string, string> = {},
): Promise<{ repo: string; context: RouteContext }> {
  const repo = await tmp("rivetari-keyword-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const files: Record<string, string> = {
    "src/total.js": "exports.total = () => 0;\n",
    ".rivetari/profile.yml":
      "version: 1\nname: demo\ntype: library\nautonomy: review-at-pr\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  return {
    repo,
    context: {
      manifests,
      available: new Set(),
      flags: {},
      files: Object.keys(files),
      checks: ["quality.tests.pass"],
    },
  };
}

const card = (description: string, extra: Record<string, unknown> = {}) => ({
  title: "Fix total so it sums",
  type: "fix" as const,
  description,
  acceptance: [
    { id: "A1", text: "total sums a list", verify: "unit" as const },
  ],
  touches: ["src/total.js"],
  ...extra,
});

const METRICS = "total() returns 0 in the metrics; it should sum its list.";

describe("keyword-only borderline sectors", () => {
  it("decides a sector that scored only on description keywords as not in", async () => {
    const { context } = await repoAtReviewAtPr();
    const routing = route({
      ...context,
      card: parseCard({
        id: "T-0001",
        ...card(METRICS),
        owner: "dev@example.com",
        created: "2026-11-23",
      }),
    });
    expect(routing.assembly.sectors).not.toContain("observability");
    expect(routing.borderline).toContain("observability");
    expect(routing.decidedOut).toEqual(["observability"]);
  });

  it("approves the route without asking, and the ledger says the sector was decided not in", async () => {
    const { repo, context } = await repoAtReviewAtPr();
    const draft = await newTask(repo, card(METRICS), by);
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.waiting).toBeUndefined();
    expect(advance.did).toContain(
      "route approved without asking (autonomy review-at-pr)",
    );
    expect(advance.task.approved).toBe(true);
    const ledger = await readFile(advance.task.ledger.mdPath, "utf8");
    expect(ledger).toContain(
      "under the threshold, for the approver: observability",
    );
    expect(ledger).toContain(
      "decided not in: observability (scored only on description keywords)",
    );
  });

  it("doesn't hold a route resumed from its ledger on a keyword-only sector", async () => {
    const { repo, context } = await repoAtReviewAtPr();
    const draft = await newTask(repo, card(METRICS), by);
    await confirmTask(repo, draft.card.id, by);
    await routeTask(repo, draft.card.id, { ...by, context });
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.waiting).toBeUndefined();
    expect(advance.task.approved).toBe(true);
  });

  it("still holds the route on a sector that scores from a skill's path trigger", async () => {
    const { repo, context } = await repoAtReviewAtPr();
    const draft = await newTask(
      repo,
      card("total() returns 0; it should sum its list.", {
        touches: ["src/styles/**"],
      }),
      by,
    );
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.task.approved).toBe(false);
    expect(advance.waiting).toContain("borderline sector(s): ui");
  });

  it("counts a skill's path trigger as path evidence, not keyword-only", async () => {
    const { context } = await repoAtReviewAtPr();
    const routing = route({
      ...context,
      card: parseCard({
        id: "T-0001",
        ...card("total() returns 0; it should sum its list.", {
          touches: ["src/styles/**"],
        }),
        owner: "dev@example.com",
        created: "2026-11-23",
      }),
    });
    const ui = routing.scores.find((s) => s.sector === "ui");
    expect(
      ui?.reasons.some((r) => /^skill \S+ triggers on src\/styles/.test(r)),
    ).toBe(true);
    expect(routing.borderline).toContain("ui");
    expect(routing.decidedOut).not.toContain("ui");
  });

  it("still holds the route on infra when the repo has infrastructure as code", async () => {
    const { repo, context } = await repoAtReviewAtPr({
      "infra/main.tf": 'terraform {\n  required_version = ">= 1.5"\n}\n',
    });
    const text = "total() returns 0; it should sum its list.";
    const routing = route({
      ...context,
      card: parseCard({
        id: "T-0001",
        ...card(text),
        owner: "dev@example.com",
        created: "2026-11-23",
      }),
    });
    expect(routing.borderline).toEqual(["infra"]);
    expect(routing.decidedOut).toEqual([]);
    const draft = await newTask(repo, card(text), by);
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.task.approved).toBe(false);
    expect(advance.waiting).toContain("borderline sector(s): infra");
  });
});

describe("a skill trigger matched by a word in the description", () => {
  const routed = async (description: string) => {
    const { context } = await repoAtReviewAtPr();
    return route({
      ...context,
      card: parseCard({
        id: "T-0001",
        ...card(description),
        owner: "dev@example.com",
        created: "2026-11-23",
      }),
    });
  };

  it("doesn't count \"iac\" again: infra scores 1 for the keyword and isn't in", async () => {
    const routing = await routed(
      "total() returns 0 in the iac report; it should sum its list.",
    );
    const infra = routing.scores.find((s) => s.sector === "infra");
    expect(infra?.score).toBe(1);
    expect(infra?.reasons).toEqual(['"iac" in the description']);
    expect(routing.assembly.sectors).not.toContain("infra");
    expect(routing.decidedOut).toContain("infra");
  });

  it('makes infra borderline on "state" only as keyword evidence, which doesn\'t hold the route', async () => {
    const description = "total() returns 0 for the saved state; it should sum.";
    const routing = await routed(description);
    expect(routing.borderline).toContain("infra");
    expect(routing.decidedOut).toContain("infra");
    const { repo, context } = await repoAtReviewAtPr();
    const draft = await newTask(repo, card(description), by);
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.waiting).toBeUndefined();
    expect(advance.task.approved).toBe(true);
    const ledger = await readFile(advance.task.ledger.mdPath, "utf8");
    expect(ledger).toContain(
      "decided not in: infra (scored only on description keywords)",
    );
  });

  it("is keyword-only for a sector with no keyword of its own for the word", async () => {
    const { repo, context } = await repoAtReviewAtPr();
    const draft = await newTask(
      repo,
      card("total() returns 0; it should sum and keep its typography."),
      by,
    );
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.waiting).toBeUndefined();
    expect(advance.task.approved).toBe(true);
    const ledger = await readFile(advance.task.ledger.mdPath, "utf8");
    expect(ledger).toContain(
      "decided not in: ui (scored only on description keywords)",
    );
  });

  it("still counts when the word is in the title, which isn't keyword-only", async () => {
    const { context } = await repoAtReviewAtPr();
    const routing = route({
      ...context,
      card: parseCard({
        id: "T-0001",
        ...card("total() returns 0; it should sum its list."),
        title: "Keep the saved state when total sums",
        owner: "dev@example.com",
        created: "2026-11-23",
      }),
    });
    expect(routing.borderline).toContain("infra");
    expect(routing.decidedOut).not.toContain("infra");
  });
});
