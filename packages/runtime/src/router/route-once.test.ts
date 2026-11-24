// Routing a task twice to the same assembly records it once (R-9: the
// pilot's T-0008 ledger said "assembly proposed" twice with one sha).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmTask, newTask } from "../task/tasks.js";
import { approveRoute, type RouteContext, routeTask } from "./task-route.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
let repo: string;
let context: RouteContext;
const by = { by: "dev@example.com", now: new Date("2026-11-24T00:14:42Z") };

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
  repo = await mkdtemp(join(tmpdir(), "rivetari-route-once-"));
  made.push(config, repo);
  process.env.RIVETARI_CONFIG_DIR = config;
  const { manifests } = await loadManifests(repo);
  context = {
    manifests,
    available: new Set(),
    locked: new Set(),
    files: ["src/lib/backend/index.ts"],
    checks: ["quality.tests.pass"],
  };
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function confirmedTask(): Promise<string> {
  const draft = await newTask(
    repo,
    {
      title:
        "Add a documented http backend adapter stub for a future Cloud Run API",
      type: "feature",
      description:
        "BreathCloud runs on the local adapter for now, and the backend seam gets an http adapter stub with the same interface.",
      acceptance: [
        {
          id: "A1",
          text: "src/lib/backend/http/index.ts exports createHttpBackend(), which throws",
          verify: "unit",
        },
      ],
      touches: ["src/lib/backend/**"],
      risk: "low",
    },
    by,
  );
  await confirmTask(repo, draft.card.id, by);
  return draft.card.id;
}

const proposals = (texts: string[]) =>
  texts.filter((t) => t.startsWith("assembly proposed; "));

describe("routing again", () => {
  it("doesn't record the same proposal twice", async () => {
    const id = await confirmedTask();
    const first = await routeTask(repo, id, { ...by, context });
    const second = await routeTask(repo, id, { ...by, context });
    const texts = second.task.entries.map((e) => e.text);
    expect(proposals(texts)).toHaveLength(1);
    expect(second.task.entries).toHaveLength(first.task.entries.length);
    expect(texts.filter((t) => t.startsWith("routed to "))).toHaveLength(1);
    const approved = await approveRoute(repo, id, { ...by, context });
    expect(approved.task.approved).toBe(true);
  });

  it("records a proposal that changed", async () => {
    const id = await confirmedTask();
    await routeTask(repo, id, { ...by, context });
    const rerouted = await routeTask(repo, id, {
      ...by,
      // A test file under the card's touches brings testing in.
      context: {
        ...context,
        files: ["src/lib/backend/index.ts", "src/lib/backend/http.test.ts"],
      },
    });
    expect(proposals(rerouted.task.entries.map((e) => e.text))).toHaveLength(2);
  });
});
