import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { nowRepo } from "./now-fixture";
import { postureRepo } from "./posture-fixture";

// Two repos for Home, built from the Now and Posture fixtures:
//   busy     the Now fixture: T-0006 running, five things waiting on a
//            person, and a task that closed today for $1.25; no audit yet
//   audited  the Posture fixture: an audit recorded in state.json that puts
//            the repo at build while profile.yml declares scaffold; no tasks

export const CLOSED_TODAY_USD = 1.25;

export function homeRepos(): { busy: string; audited: string } {
  const { repo: busy } = nowRepo();
  appendFileSync(
    join(busy, ".rivetari", "history.jsonl"),
    `${JSON.stringify({
      kind: "task",
      date: new Date().toISOString().slice(0, 10),
      task: "T-0007",
      type: "feature",
      outcome: "merged",
      pr: 40,
      sectors: ["ui"],
      skills: [],
      minutes: 60,
      tokens: 1200,
      cost_usd: CLOSED_TODAY_USD,
      build_rounds: 1,
      judge_rounds: 1,
      risk: "low",
    })}\n`,
  );
  return { busy, audited: postureRepo() };
}
