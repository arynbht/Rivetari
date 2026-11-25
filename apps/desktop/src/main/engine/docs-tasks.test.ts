import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listDocs } from "./docs";

// History shows the repo's own docs. Task ledgers are left to Tasks, which
// already shows each task's record, so they don't bury the docs here.

let repo = "";

function write(path: string, text: string): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "t3c-docs-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("listDocs", () => {
  it("lists the repo's docs and leaves out the task ledgers", async () => {
    write("AGENTS.md", "# Agents");
    write("docs/architecture.md", "# Architecture");
    write(".rivetari/autonomy/ledger.md", "# Autonomy");
    write(".rivetari/tasks/T-0001/card.md", "# Card");
    write(".rivetari/tasks/T-0002/proof/notes.md", "# Proof");

    const paths = (await listDocs(repo)).map((d) => d.path);
    expect(paths).toEqual([
      ".rivetari/autonomy/ledger.md",
      "AGENTS.md",
      "docs/architecture.md",
    ]);
  });
});
