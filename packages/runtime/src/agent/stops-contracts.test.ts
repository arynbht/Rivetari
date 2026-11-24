// The schema stop covers contract files, not only migrations (the pilot's
// R-24: T-0019 changed src/lib/domain/types.ts, the contract with the
// Flutter app, and nothing stopped), and says whether a change only adds.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { isSoftStop } from "../task/autonomy.js";
import { findStops } from "./stops.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const assembly = { stop_and_ask: ["schema_change"] } as unknown as Parameters<
  typeof findStops
>[3];

async function change(
  base: Record<string, string>,
  edits: Record<string, string | null>,
): Promise<{ dir: string; from: string; to: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-contracts-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) await rm(join(dir, path));
      else {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
      }
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const from = await write(base);
  const to = await write(edits);
  return { dir, from, to };
}

// T-0019's src/lib/domain/types.ts, cut to the parts its change touched.
const TYPES = `// The data contract with the Flutter app.

export type Role = "athlete" | "coach";

export interface TransitionScores {
  smoothness: InhaleExhale | null;
}

export const SCORING_VERSIONS = {
  legacy: "legacy-v1",
  transition: "transition-v1",
} as const;

export interface SessionSummary {
  appVersion: string;
  groupSessionId?: string | null;
}

/** The raw signal for one session. */
export interface Waveform {
  sampleIntervalMs: number;
  user: number[];
  pacer: number[] | null;
  markers: number[];
  calibration: { min: number; max: number };
}
`;

// What T-0019's build committed (PR #29): nine additions, one of which
// rewrites the calibration line and one adds a key to SCORING_VERSIONS.
const T0019 = TYPES.replace(
  `export type Role`,
  `import type { SkillLevel } from "@/lib/analysis/config";\n\nexport type Role`,
)
  .replace(
    `  smoothness: InhaleExhale | null;\n}\n`,
    `  smoothness: InhaleExhale | null;\n}\n\nexport interface NullableInhaleExhale {\n  inhale: number | null;\n  exhale: number | null;\n}\n\nexport interface PacedDetails {\n  onTargetPct: { timing: number; depth: number };\n  missed: number;\n}\n`,
  )
  .replace(
    `  transition: "transition-v1",\n`,
    `  transition: "transition-v1",\n  methodC: "method-c-v1",\n`,
  )
  .replace(
    `  groupSessionId?: string | null;\n}\n`,
    `  groupSessionId?: string | null;\n  skillLevel?: SkillLevel;\n  paced?: PacedDetails | null;\n}\n\nexport type WaveformUnits = "raw" | "pct-max";\n`,
  )
  .replace(
    `  user: number[];\n`,
    `  user: number[];\n  units?: WaveformUnits;\n`,
  )
  .replace(
    `  calibration: { min: number; max: number };`,
    `  calibration: { min: number; max: number; a100?: number; midline?: number; peaks?: number[]; troughs?: number[] };`,
  );

const CONTRACTS = { contracts: ["src/lib/domain/types.ts"] };

describe("the schema stop on contract files", () => {
  it("stops on T-0019's types.ts change when the profile names it a contract, and asks", async () => {
    const { dir, from, to } = await change(
      { "src/lib/domain/types.ts": TYPES },
      { "src/lib/domain/types.ts": T0019 },
    );
    const stops = await findStops(dir, from, to, assembly, CONTRACTS);
    expect(stops).toHaveLength(1);
    const [stop] = stops;
    expect(stop?.trigger).toBe("schema_change");
    expect(stop?.detail).toMatch(/^touches src\/lib\/domain\/types\.ts — /);
    // The widened calibration line and the new SCORING_VERSIONS key are
    // what make it more than additive.
    expect(stop?.detail).toContain(
      "removes or changes `calibration: { min: number; max: number };`",
    );
    expect(stop?.detail).toContain('adds `methodC: "method-c-v1",`');
    expect(stop?.additive).toBe(false);
    expect(isSoftStop(stop!)).toBe(false);
  });

  it("doesn't take a types file for a contract unless the profile says so", async () => {
    const { dir, from, to } = await change(
      { "src/lib/domain/types.ts": TYPES },
      { "src/lib/domain/types.ts": T0019 },
    );
    expect(await findStops(dir, from, to, assembly)).toEqual([]);
  });

  it("flags, rather than asks, a change that only adds optional fields and new types", async () => {
    const additive = TYPES.replace(
      `  user: number[];\n`,
      `  user: number[];\n  units?: WaveformUnits;\n`,
    ).replace(
      `export type Role`,
      `export interface DeviationHistogram {\n  timing: number[];\n  depth: number[];\n}\n\nexport type WaveformUnits = "raw" | "pct-max";\n\nexport type Role`,
    );
    const { dir, from, to } = await change(
      { "src/lib/domain/types.ts": TYPES },
      { "src/lib/domain/types.ts": additive },
    );
    const [stop] = await findStops(dir, from, to, assembly, CONTRACTS);
    expect(stop).toMatchObject({
      trigger: "schema_change",
      detail: "touches src/lib/domain/types.ts",
      additive: true,
    });
    expect(isSoftStop(stop!)).toBe(true);
  });

  it("asks about a removed field, a rename, and a deleted contract", async () => {
    const { dir, from, to } = await change(
      {
        "src/lib/domain/types.ts": TYPES,
        "proto/session.proto": "message Session {\n  string id = 1;\n}\n",
        "api/old.graphql": "type Query {\n  me: User\n}\n",
      },
      {
        "src/lib/domain/types.ts": TYPES.replace("  markers: number[];\n", ""),
        "proto/session.proto": null,
        "api/old.graphql": null,
        "api/new.graphql": "type Query {\n  me: User\n}\n",
      },
    );
    const [stop] = await findStops(dir, from, to, assembly, CONTRACTS);
    expect(stop?.additive).toBe(false);
    expect(stop?.detail).toContain(
      "src/lib/domain/types.ts removes or changes `markers: number[];`",
    );
    expect(stop?.detail).toContain("proto/session.proto deletes the file");
    expect(stop?.detail).toContain(
      "api/new.graphql renames it from api/old.graphql",
    );
  });

  it("knows the common schema and contract formats without a profile", async () => {
    const { dir, from, to } = await change(
      {
        "api/openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
        "proto/session.proto": "message Session {\n  string id = 1;\n}\n",
        "schema/user.schema.json": '{ "type": "object" }\n',
        "db/schema.graphql": "type User {\n  id: ID!\n}\n",
      },
      {
        "api/openapi.yaml": "openapi: 3.1.0\npaths:\n  /users: {}\n",
        "proto/session.proto":
          "message Session {\n  string id = 1;\n  optional string coach = 2;\n}\n",
        "schema/user.schema.json": '{ "type": "object", "required": ["id"] }\n',
        "db/schema.graphql": "type User {\n  id: ID!\n  nickname: String\n}\n",
      },
    );
    const [stop] = await findStops(dir, from, to, assembly);
    expect(stop?.trigger).toBe("schema_change");
    expect(stop?.detail).toMatch(
      /^touches api\/openapi\.yaml, db\/schema\.graphql, proto\/session\.proto, schema\/user\.schema\.json — /,
    );
    // OpenAPI and JSON Schema keep `required` apart from the fields, so an
    // addition there can't be told optional from its line: it's asked.
    expect(stop?.detail).toContain("api/openapi.yaml adds `paths:`");
    expect(stop?.detail).not.toContain("proto/session.proto adds");
    expect(stop?.detail).not.toContain("db/schema.graphql adds");
    expect(stop?.additive).toBe(false);
  });

  it("flags a new optional proto field or nullable GraphQL field on its own", async () => {
    const { dir, from, to } = await change(
      {
        "proto/session.proto": "message Session {\n  string id = 1;\n}\n",
        "db/schema.graphql": "type User {\n  id: ID!\n}\n",
      },
      {
        "proto/session.proto":
          "message Session {\n  string id = 1;\n  optional string coach = 2;\n}\n\nmessage Coach {\n  string name = 1;\n}\n",
        "db/schema.graphql": "type User {\n  id: ID!\n  nickname: String\n}\n",
      },
    );
    const [stop] = await findStops(dir, from, to, assembly);
    expect(stop).toMatchObject({ trigger: "schema_change", additive: true });
  });

  it("asks about a migration that drops a column or adds a required one, and flags one that adds a table", async () => {
    const dropped = await change(
      { "db/migrations/001.sql": "CREATE TABLE users (id int);\n" },
      {
        "db/migrations/002.sql": "ALTER TABLE users DROP COLUMN nickname;\n",
      },
    );
    const [drop] = await findStops(
      dropped.dir,
      dropped.from,
      dropped.to,
      assembly,
    );
    expect(drop?.additive).toBe(false);
    expect(drop?.detail).toContain(
      "db/migrations/002.sql adds `ALTER TABLE users DROP COLUMN nickname;`, which isn't optional",
    );

    const required = await change(
      { "db/migrations/001.sql": "CREATE TABLE users (id int);\n" },
      {
        "db/migrations/002.sql":
          "ALTER TABLE users ADD COLUMN email text NOT NULL;\n",
      },
    );
    const [req] = await findStops(
      required.dir,
      required.from,
      required.to,
      assembly,
    );
    expect(req?.additive).toBe(false);

    const table = await change(
      { "db/migrations/001.sql": "CREATE TABLE users (id int);\n" },
      {
        "db/migrations/002.sql":
          "CREATE TABLE coaches (\n  id int NOT NULL,\n  name text\n);\nALTER TABLE users ADD COLUMN coach int;\n",
      },
    );
    const [add] = await findStops(table.dir, table.from, table.to, assembly);
    expect(add).toMatchObject({
      detail: "touches db/migrations/002.sql",
      additive: true,
    });
  });
});
