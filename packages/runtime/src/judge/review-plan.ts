// Which model reviews a change and how hard it thinks, from the risk the
// judge derived and the change itself, so the spend follows what's at stake.
// In the pilot most reviews cost $0.05–0.46, but two low- and medium-risk
// ones on the strong model at its default effort (six new test files; one
// design doc) ran to 275k–293k tokens, one with 134k of output, and cost
// about $3.67 each. The six the smaller model reviewed cost $0.03–0.10.
import { type Effort } from "@arynbht/rivetari-engine";
import picomatch from "picomatch";

import type { Risk } from "../task/risk.js";
import { judgeGit } from "./git.js";
import { FAST_REVIEW_MODEL } from "./fast-path.js";
import { isTestFile, parseNameStatus } from "./protected.js";
import { generatedPaths, JUDGE_DEFAULT_MODEL } from "./tier2.js";

/**
 * Changed source lines (tests, docs and generated files aside) at most for a
 * low-risk change to go to the smaller model. The pilot's low-risk cards were
 * 20–250 source lines; past this a change is big enough that a missed defect
 * costs more than the stronger model does.
 */
export const SMALL_CHANGE_LINES = 300;

export interface ReviewPlan {
  model: string;
  effort: Effort;
  why: string;
}

export interface ChangeSize {
  /** Added plus removed lines outside tests, docs and generated files. */
  source: number;
  tests: number;
  /** Whether a changed path is on the repo's sensitive list. */
  sensitive: boolean;
}

const DOC = /\.(md|mdx|txt)$/i;

/** How much of the change is source, and whether it reaches a sensitive path. */
export async function changeSize(
  repoPath: string,
  base: string,
  head: string,
  sensitive: readonly string[],
): Promise<ChangeSize> {
  const git = judgeGit(repoPath);
  const rows = (
    await git.raw(["diff", "--numstat", "--no-renames", base, head])
  )
    .split("\n")
    .flatMap((line) => {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      return m
        ? [{ lines: Number(m[1]) + Number(m[2]) || 0, path: m[3] ?? "" }]
        : [];
    });
  const generated = await generatedPaths(
    git,
    rows.map((r) => r.path),
  );
  const isSensitive =
    sensitive.length > 0 ? picomatch([...sensitive], { dot: true }) : null;
  const paths = parseNameStatus(
    await git.raw(["diff", "--name-status", "-M", base, head]),
  ).flatMap((e) => [e.path, ...(e.oldPath ? [e.oldPath] : [])]);
  let source = 0;
  let tests = 0;
  for (const r of rows) {
    if (generated.has(r.path)) continue;
    if (isTestFile(r.path)) tests += r.lines;
    else if (!DOC.test(r.path)) source += r.lines;
  }
  return {
    source,
    tests,
    sensitive: isSensitive ? paths.some((p) => isSensitive(p)) : false,
  };
}

/**
 * The review's model and effort. A model named for the run (`--model`) is
 * used as given; otherwise:
 *  - high risk, or a path on the sensitive list: the strong model at high
 *    effort, where the pilot's real defects were (scoring, contract files);
 *  - low risk and small: the small model at medium effort;
 *  - anything else: the strong model at medium effort, which keeps its
 *    judgement and stops the long runaway thinking.
 */
export function reviewPlan(input: {
  risk: Risk;
  size: ChangeSize;
  forced?: string | undefined;
  strong?: string | undefined;
  small?: string | undefined;
}): ReviewPlan {
  const strong = input.strong ?? JUDGE_DEFAULT_MODEL;
  const small = input.small ?? FAST_REVIEW_MODEL;
  const high = input.risk === "high" || input.size.sensitive;
  const effort: Effort = high ? "high" : "medium";
  if (input.forced)
    return { model: input.forced, effort, why: "the model named for the run" };
  if (high)
    return {
      model: strong,
      effort,
      why: input.size.sensitive
        ? "it touches the repo's sensitive list"
        : "high risk",
    };
  if (input.risk === "low" && input.size.source <= SMALL_CHANGE_LINES)
    return {
      model: small,
      effort,
      why: `low risk, ${input.size.source} source line(s) changed`,
    };
  return {
    model: strong,
    effort,
    why:
      input.risk === "low"
        ? `low risk but ${input.size.source} source lines changed`
        : `${input.risk} risk`,
  };
}
