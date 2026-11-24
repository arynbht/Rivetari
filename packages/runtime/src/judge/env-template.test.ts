// An env template is a normal file (the pilot's R-2: T-0011's .env.example
// raised the task to high risk and was withheld from the reviewer, which then
// couldn't verify the criterion about it). A real secret in one is still
// caught, from its contents.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnvTemplate, isSensitivePath } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { findStops } from "../agent/stops.js";
import { deriveRisk } from "../task/risk.js";
import { packChange } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithChange(
  base: Record<string, string>,
  change: Record<string, string>,
): Promise<{ dir: string; base: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-env-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), contents, "utf8");
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const b = await write(base);
  const h = await write(change);
  return { dir, base: b, head: h };
}

// breathband-console's .env.example before and after T-0011.
const BEFORE = "# local | firebase\nNEXT_PUBLIC_BACKEND=local\n";
const AFTER =
  "# local | firebase | http\nNEXT_PUBLIC_BACKEND=local\n# Needed once NEXT_PUBLIC_BACKEND=http (base URL of the future Cloud Run API)\n# NEXT_PUBLIC_API_BASE_URL=\n";

const T0011_TOUCHES = [
  "src/lib/backend/http/index.ts",
  "src/lib/backend/index.ts",
  "src/lib/backend/types.ts",
  ".env.example",
];

describe("env templates", () => {
  it("are templates by name; a real .env still isn't", () => {
    for (const p of [".env.example", "apps/web/.env.sample", ".env.template"])
      expect([isEnvTemplate(p), isSensitivePath(p)]).toEqual([true, false]);
    for (const p of [".env", ".env.local", ".env.production", "web/.env"])
      expect([isEnvTemplate(p), isSensitivePath(p)]).toEqual([false, true]);
  });

  it("don't make T-0011 high risk; a real .env does", () => {
    expect(deriveRisk({ paths: T0011_TOUCHES }).risk).not.toBe("high");
    expect(
      deriveRisk({ paths: [...T0011_TOUCHES, ".env.local"] }),
    ).toMatchObject({
      risk: "high",
      reasons: ["high: secrets handling (.env.local)"],
    });
  });

  it("are shown to the reviewer, unless what they hold looks like a secret", async () => {
    const shown = await repoWithChange(
      { ".env.example": BEFORE },
      { ".env.example": AFTER },
    );
    const packed = await packChange(shown.dir, shown.base, shown.head);
    expect(packed.files).toContain(".env.example");
    expect(packed.diff).toContain("+# NEXT_PUBLIC_API_BASE_URL=");
    expect(packed.omitted).toEqual([]);

    const key = `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`;
    const leaked = await repoWithChange(
      { ".env.example": BEFORE },
      { ".env.example": `${BEFORE}STRIPE_SECRET_KEY=${key}\n` },
    );
    const withheld = await packChange(leaked.dir, leaked.base, leaked.head);
    expect(withheld.omitted).toEqual([
      { path: ".env.example", why: "looks like it holds a secret" },
    ]);
    const stops = await findStops(leaked.dir, leaked.base, leaked.head, {
      stop_and_ask: [],
    } as unknown as Parameters<typeof findStops>[3]);
    expect(stops).toContainEqual({
      trigger: "secret",
      detail: ".env.example adds a line that looks like a secret",
    });
  });
});
