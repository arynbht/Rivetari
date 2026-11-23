// A card's risk is derived from what it touches, not declared: intake derives
// it from the card's touches, the judge derives it again from the diff, and
// the higher one counts. A declared risk can raise it but never lower it. The
// signals are generic globs, so they mean the same thing in any repo, plus the
// repo's own sensitive list.
import { isSensitivePath } from "@arynbht/rivetari-engine";
import picomatch from "picomatch";

import { PROTECTED } from "../judge/protected.js";
import { RISKS } from "./card.js";
import { trackedFiles } from "./touches.js";

export type Risk = (typeof RISKS)[number];

export interface DerivedRisk {
  risk: Risk;
  /** One line per signal that fired, "high: <signal> (<paths>)". */
  reasons: string[];
}

interface Signal {
  risk: "high" | "medium";
  what: string;
  globs: readonly string[];
  /** Paths the globs miss that still carry the signal. */
  also?: ((path: string) => boolean) | undefined;
}

const SIGNALS: readonly Signal[] = [
  {
    risk: "high",
    what: "signing or key handling",
    globs: [
      "**/{signing,keys}/**",
      "**/*{signing,signature,codesign,notarize,notarise,keychain,keyring}*",
      "**/{key,keys}.*",
      "**/*[-_.]{key,keys}.*",
    ],
  },
  {
    risk: "high",
    what: "leases",
    globs: [
      "**/{lease,leases}/**",
      "**/{lease,leases}.*",
      "**/*[-_.]{lease,leases}.*",
      "**/{lease,leases}[-_.]*",
    ],
  },
  {
    risk: "high",
    what: "the autonomy ledger",
    globs: [
      "**/.rivetari/autonomy/**",
      "**/{ledger,ledgers}/**",
      "**/ledger.*",
      "**/*[-_.]ledger.*",
    ],
  },
  {
    risk: "high",
    what: "auth, billing or payments",
    globs: [
      "**/{auth,authn,authz,oauth,billing,payment,payments,checkout}/**",
      "**/{auth,oauth,billing,payment,payments}.*",
      "**/*[-_.]{auth,oauth,billing,payment,payments}.*",
    ],
  },
  {
    risk: "high",
    what: "a migration or schema",
    globs: [
      "**/{migrations,migrate}/**",
      "**/*.sql",
      "**/*.prisma",
      "**/{schema,schemas}/**",
      "**/schema.*",
      "**/*[-_.]schema.*",
    ],
  },
  {
    risk: "high",
    what: "infrastructure as code",
    globs: [
      "**/{infra,infrastructure,terraform,k8s,kubernetes,helm}/**",
      "**/*.{tf,tfvars,bicep}",
      "**/Pulumi.*",
      "**/cdk.json",
      "**/Dockerfile*",
      "**/docker-compose*.{yml,yaml}",
    ],
  },
  {
    risk: "high",
    what: "secrets handling",
    globs: ["**/*{secret,credential}*", "**/.env*", "**/redact.*"],
    also: isSensitivePath,
  },
  {
    risk: "medium",
    what: "CI or workflow config",
    globs: [
      ...PROTECTED.ciConfig,
      ".gitlab-ci.yml",
      ".circleci/**",
      ".buildkite/**",
      "azure-pipelines.yml",
      "Jenkinsfile",
    ],
  },
  {
    risk: "medium",
    what: "dependencies or a lockfile",
    globs: [
      "**/package.json",
      "**/{pnpm-lock.yaml,package-lock.json,yarn.lock,bun.lockb,pnpm-workspace.yaml}",
      "**/requirements*.txt",
      "**/{pyproject.toml,poetry.lock,uv.lock,Pipfile,Pipfile.lock}",
      "**/{go.mod,go.sum,Cargo.toml,Cargo.lock,Gemfile,Gemfile.lock}",
      "**/composer.{json,lock}",
    ],
  },
  {
    risk: "medium",
    what: "lint or tsconfig config",
    globs: [...PROTECTED.lintConfig, "**/.lintstagedrc*"],
  },
];

const matchers = SIGNALS.map((s) => ({
  ...s,
  isMatch: picomatch([...s.globs], { dot: true }),
}));

/**
 * Lines that handle leases, signatures or keys, for code whose path doesn't
 * say so (this repo's lease code sits in its task store). "release" and
 * "please" don't match.
 */
const SIGNAL_LINE =
  /(?<![A-Za-z])lease|(?<![A-Z])Lease|(?<![A-Z])LEASE|createHmac|createSign|createVerify|generateKeyPair|privateKey|PRIVATE KEY/;

const ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export const isHigher = (a: Risk, b: Risk) => ORDER[a] > ORDER[b];

export function higherRisk(a: Risk, b: Risk): Risk {
  return isHigher(b, a) ? b : a;
}

const SHOWN = 3;
const listed = (paths: readonly string[]) =>
  `${paths.slice(0, SHOWN).join(", ")}${paths.length > SHOWN ? `, and ${paths.length - SHOWN} more` : ""}`;

export interface RiskInput {
  /** The paths changed (or, at intake, the card's touches and what they match). */
  paths: readonly string[];
  /** The repo's sensitive list: globs that count as medium. */
  sensitive?: readonly string[] | undefined;
  /** Existing tests the change edits that the card doesn't name. */
  unnamedTests?: readonly string[] | undefined;
  /** Each changed file's added and removed lines, when the diff is known. */
  lines?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** The risk the paths (and, from a diff, the lines) carry, with why. */
export function deriveRisk(input: RiskInput): DerivedRisk {
  const fired: { risk: "high" | "medium"; what: string; paths: string[] }[] =
    [];
  const add = (risk: "high" | "medium", what: string, paths: string[]) => {
    if (paths.length > 0) fired.push({ risk, what, paths });
  };
  for (const s of matchers)
    add(
      s.risk,
      s.what,
      input.paths.filter((p) => s.isMatch(p) || (s.also?.(p) ?? false)),
    );
  add(
    "high",
    "lease, signing or key code",
    [...(input.lines ?? new Map<string, readonly string[]>())]
      .filter(
        ([path, lines]) =>
          !path.endsWith(".md") && lines.some((l) => SIGNAL_LINE.test(l)),
      )
      .map(([path]) => path),
  );
  if (input.sensitive && input.sensitive.length > 0) {
    const isSensitive = picomatch([...input.sensitive], { dot: true });
    add(
      "medium",
      "the repo's sensitive list",
      input.paths.filter((p) => isSensitive(p)),
    );
  }
  add("medium", "existing tests the card doesn't name", [
    ...(input.unnamedTests ?? []),
  ]);
  fired.sort((a, b) => ORDER[b.risk] - ORDER[a.risk]);
  return {
    risk: fired[0]?.risk ?? "low",
    reasons: fired.map((f) => `${f.risk}: ${f.what} (${listed(f.paths)})`),
  };
}

/** The ledger's line for a card's risk at intake. */
export function intakeRiskNote(
  derived: DerivedRisk,
  declared: Risk | undefined,
): string {
  const risk = declared ? higherRisk(derived.risk, declared) : derived.risk;
  const why =
    derived.reasons.length > 0
      ? `derived from the touches: ${derived.reasons.join("; ")}`
      : "no high or medium signal in the touches";
  if (!declared || declared === derived.risk) return `risk ${risk}: ${why}`;
  return isHigher(declared, derived.risk)
    ? `risk ${risk}: declared ${declared}, raised from ${derived.risk} (${why})`
    : `risk ${risk}: ${why} (the declared ${declared} can't lower it)`;
}

/** A card's touches, with the tracked files each glob among them matches. */
export async function touchedPaths(
  repoPath: string,
  touches: readonly string[],
): Promise<string[]> {
  const globs = touches.filter((t) => picomatch.scan(t).isGlob);
  if (globs.length === 0) return [...touches];
  const isMatch = picomatch(globs, { dot: true });
  const matched = (await trackedFiles(repoPath)).filter((f) => isMatch(f));
  return [...new Set([...touches, ...matched])];
}
