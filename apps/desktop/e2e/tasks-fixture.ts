import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A repo with Rivetari tasks for the Tasks tab, written the way the runtime
// writes them: a card, a ledger chained by HMAC, an assembly, a lease. The app is
// launched with RIVETARI_LEDGER_KEY set to the same key, so the records verify
// without touching the developer's own ledger key.

/** A throwaway key (not a secret): the app is given it through the env. */
export const LEDGER_KEY = "ab".repeat(32);

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type Entry = [beat: string, section: string, text: string];

const ASSEMBLY = "sectors: [desktop]\nskills: []\n";
const AT = "2026-11-20T10:00:00.000Z";
const BY = "ann@example.com";

/** Writes ledger entries for one task, chained to the last one it wrote. */
class Ledger {
  private seq = 0;
  private prev = "genesis";
  constructor(private readonly dir: string) {}

  append([beat, section, text]: Entry, at = AT): void {
    this.seq += 1;
    const base = {
      seq: this.seq,
      at,
      beat,
      section,
      text,
      by: BY,
      prev: this.prev,
    };
    const mac = createHmac("sha256", Buffer.from(LEDGER_KEY, "hex"))
      .update(
        JSON.stringify([
          base.seq,
          base.at,
          base.beat,
          base.section,
          base.text,
          base.by,
          base.prev,
        ]),
      )
      .digest("hex");
    appendFileSync(
      join(this.dir, "ledger.jsonl"),
      `${JSON.stringify({ ...base, mac })}\n`,
    );
    this.prev = mac;
  }
}

function writeTask(
  repo: string,
  id: string,
  title: string,
  entries: Entry[],
  lease?: object,
): Ledger {
  const dir = join(repo, ".rivetari", "tasks", id);
  mkdirSync(dir, { recursive: true });
  const card = [
    `id: ${id}`,
    `title: ${title}`,
    "type: feature",
    "source: prompt",
    "description: A task for the Tasks tab fixture.",
    "acceptance:",
    "  - id: A1",
    "    text: It works",
    "    verify: e2e",
    "out_of_scope: []",
    "touches: []",
    "pages: []",
    "constraints: []",
    "risk: medium",
    `owner: ${BY}`,
    "created: 2026-11-20",
    "",
  ].join("\n");
  writeFileSync(join(dir, "card.yml"), card);
  writeFileSync(join(dir, "assembly.yml"), ASSEMBLY);
  if (lease) writeFileSync(join(dir, "lease.json"), JSON.stringify(lease));
  const ledger = new Ledger(dir);
  for (const entry of [
    [
      "intake",
      "timeline",
      "card drafted with 1 acceptance criteria; awaiting confirmation",
    ],
    ["intake", "timeline", `intake confirmed; card sha256 ${sha256(card)}`],
    [
      "route",
      "timeline",
      `route approved; assembly sha256 ${sha256(ASSEMBLY)}`,
    ],
    ["isolate", "timeline", `worktree .worktrees/${id} on rivetari/${id}`],
    [
      "build",
      "timeline",
      "build started · 3 repo file(s) in context · 1200 tokens · $0.12",
    ],
    ...entries,
  ] as Entry[])
    ledger.append(entry);
  return ledger;
}

/**
 * One running task (holding a lease), one stopped to ask, one shipped. Returns
 * the repo and the running task's ledger, so a test can append to it live.
 */
export function tasksRepo(): { repo: string; running: Ledger } {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-tasks-"));
  writeFileSync(join(repo, "README.md"), "# tasks fixture\n");
  const running = writeTask(repo, "T-0001", "Add a dark mode toggle", [], {
    holder: `${BY} on build-box`,
    expires: "2099-01-01T00:00:00.000Z",
  });
  writeTask(repo, "T-0002", "Move settings to the design system", [
    ["build", "stop", "asked: dependency: adds @radix-ui/react-switch"],
    [
      "build",
      "timeline",
      "build paused: 1 thing(s) to ask about · commit abc1234 · 500 tokens · $0.05",
    ],
  ]);
  writeTask(repo, "T-0003", "Fix the update banner contrast", [
    [
      "build",
      "timeline",
      "build done · commit abc1234 · 2 file(s) this round · 800 tokens · $0.08",
    ],
    ["prove", "timeline", "proof passed · 2 screenshot(s), axe clean"],
    [
      "judge",
      "timeline",
      "judge passed · round 1 · head 0123456789ab · record sha256 00",
    ],
    [
      "ship",
      "timeline",
      "draft PR opened: #42 https://github.com/arynbht/example/pull/42 · rivetari/T-0003 at 0123456789ab → main",
    ],
  ]);
  return { repo, running };
}
