// The router: a confirmed card and the repo in, an assembly out — which
// sectors, phases, skills, checks, proof and budget the task runs with. It is
// deterministic (no model call), and every decision carries its reason, so the
// human approving the assembly sees why each part is there.
import {
  type Manifest,
  type Sector,
  SECTORS,
  SKILL_PHASES,
  type SkillPhase,
} from "@arynbht/rivetari-registry";
import picomatch from "picomatch";
import { z } from "zod";

import { type Card, RISKS } from "../task/card.js";
import {
  DESIGN_WORDS,
  FIX_WORDS,
  IAC_PATHS,
  SCHEMA_WORDS,
  SECTOR_SIGNALS,
  SENSITIVE_PATHS,
} from "./signals.js";

export const PROOF_TYPES = [
  "ui-screenshots",
  "api-contract",
  "migration-dry-run",
  "infra-plan",
  "test-run",
  "docs-render",
] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export const STOP_TRIGGERS = ["new_dependency", "schema_change"] as const;

/** Task-scope skills per assembly; the spine doesn't count. */
export const MAX_TASK_SKILLS = 4;
/** A sector is in at this score: one path hit, or one title keyword. */
export const SECTOR_THRESHOLD = 2;
/** Why a borderline sector is decided not in, as the route's ledger says it. */
export const KEYWORD_ONLY_REASON = "scored only on description keywords";
/** Critique skills in order of preference: one per task. */
const CRITIQUE = ["impeccable", "taste-skill"];
/** Loaded only when no critique skill is in the assembly. */
const CRITIQUE_FALLBACK = "frontend-design";
const STEPS: Record<(typeof RISKS)[number], number> = {
  low: 8,
  medium: 12,
  high: 16,
};
// A low-risk card's slice is a file or two and what they import: a smaller
// cap keeps a wide touches list from packing the prompt it re-reads each turn.
const CONTEXT_TOKENS: Record<(typeof RISKS)[number], number> = {
  low: 15_000,
  medium: 60_000,
  high: 60_000,
};

export const AssemblySchema = z.strictObject({
  task: z.string().min(1),
  sectors: z.array(z.enum(SECTORS)),
  phases: z.array(z.enum(SKILL_PHASES)).min(1),
  /** Loaded for this task, in this order; at most four, conflicts resolved. */
  skills: z.array(z.string().min(1)).max(MAX_TASK_SKILLS),
  /** Always-scope skills that bear on this task (installed already). */
  spine: z.array(z.string().min(1)).default([]),
  budget: z.strictObject({
    skill_tokens: z.number().int().nonnegative(),
    context_tokens: z.number().int().positive(),
    steps: z.number().int().positive(),
  }),
  /** Catalog control ids the judge's tier 1 runs. */
  checks: z.array(z.string().min(1)).min(1),
  proof: z.enum(PROOF_TYPES),
  review: z.strictObject({
    rubric: z.literal("default"),
    design_pass: z.boolean(),
    security: z.boolean(),
  }),
  stop_and_ask: z.array(
    z.union([
      z.enum(STOP_TRIGGERS),
      z.strictObject({ touches: z.array(z.string().min(1)).min(1) }),
    ]),
  ),
  /** Sectors in the task that no vendored skill covers. */
  gaps: z.array(z.string()).default([]),
});
export type Assembly = z.infer<typeof AssemblySchema>;

export interface RouteInput {
  card: Card;
  manifests: ReadonlyMap<string, Manifest>;
  /** Skills that can be loaded: locked, synced and not blocked. */
  available: ReadonlySet<string>;
  /**
   * Skills the lock holds, so a skill that matched but can't load is told
   * apart: not locked (add it) or locked but not loaded (sync it).
   */
  locked?: ReadonlySet<string> | undefined;
  /** The profile's flags. */
  flags?: Readonly<Record<string, boolean | undefined>> | undefined;
  /** The repo's files (`git ls-files`), to expand `touches` and spot IaC. */
  files?: readonly string[] | undefined;
  /** The change checks the judge can run (catalog control ids). */
  checks: readonly string[];
}

export interface SectorScore {
  sector: Sector;
  score: number;
  reasons: string[];
}

export interface Routing {
  assembly: Assembly;
  /** Every sector that scored, highest first. */
  scores: SectorScore[];
  /** Sectors that scored under the threshold: the human decides. */
  borderline: Sector[];
  /**
   * Borderline sectors the router decided are not in, since nothing but
   * words in the description scored them; still listed for the approver.
   */
  decidedOut: Sector[];
  /** Why each sector in `decidedOut` is out, as the ledger says it. */
  outReasons: Partial<Record<Sector, string>>;
  /** Decisions made along the way: conflicts, unavailable skills, the cap. */
  notes: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word (or plural) match, case-insensitive. */
export function hasWord(text: string, word: string): boolean {
  return new RegExp(
    `(?<![a-z0-9])${escape(word.toLowerCase())}s?(?![a-z0-9])`,
  ).test(text.toLowerCase());
}

/** The first touched path a glob matches: a `touches` pattern or a file it covers. */
function pathHit(
  globs: readonly string[],
  touched: readonly string[],
): string | undefined {
  for (const glob of globs) {
    const isMatch = picomatch(glob, { dot: true });
    const hit = touched.find((t) => isMatch(t));
    if (hit) return hit;
  }
  return undefined;
}

function isDocsTouch(touch: string): boolean {
  const path = touch.replace(/\\/g, "/").replace(/^\.\//, "");
  return path.toLowerCase().endsWith(".md") || path.startsWith("docs/");
}

/** Path-like words in a card: `src/lib/x.test.ts`, `docs/PLAN.md:48`, `README.md`. */
const PATHISH = /[\w.@-]+(?:\/[\w.@[\]-]+)+|[\w-]+\.[a-z][a-z0-9]{0,4}\b/gi;

/**
 * What the card touches: its `touches`, the repo files they cover, and the
 * files its text names inside them. A test file an acceptance criterion
 * promises under a `src/lib/**` touch is touched, though it doesn't exist yet.
 */
function touchedPaths(card: Card, files: readonly string[]): string[] {
  if (card.touches.length === 0) return [];
  // Wrapped: a bare matcher would take filter's index as `returnObject`.
  const isMatch = picomatch([...card.touches], { dot: true });
  const inTouches = (path: string) => isMatch(path);
  const text = [
    card.title,
    card.description,
    ...card.acceptance.map((a) => a.text),
  ].join("\n");
  const named = (text.match(PATHISH) ?? []).map((n) => n.replace(/\.+$/, ""));
  return [
    ...new Set([
      ...card.touches,
      ...files.filter(inTouches),
      ...named.filter(inTouches),
    ]),
  ];
}

/** Sectors a card that only touches docs can still be about. */
const DOC_SECTORS = new Set<Sector>(["docs", "product", "legal"]);

/** What a sector scored on. */
type Evidence = "path" | "title" | "words" | "repo";

/**
 * A sector's reasons for the ledger, shortest first: paths, then the words
 * grouped by where they were found, without a skill's path trigger that only
 * repeats a path the sector already touches.
 */
export function reasonSummary(reasons: readonly string[]): string {
  const words: Record<string, string[]> = { title: [], description: [] };
  const rest: string[] = [];
  const touches = reasons.some((r) => r.startsWith("touches "));
  for (const reason of reasons) {
    const word = /^("[^"]+") in the (title|description)$/.exec(reason);
    if (word?.[1] && word[2]) words[word[2]]?.push(word[1]);
    else if (!(touches && /^skill \S+ triggers on \S*[/.]/.test(reason)))
      rest.push(reason);
  }
  for (const [where, found] of Object.entries(words))
    if (found.length > 0) rest.push(`${found.join(", ")} in the ${where}`);
  return rest.join("; ");
}

export function route(input: RouteInput): Routing {
  const { card, manifests, available } = input;
  const flags = input.flags ?? {};
  const files = input.files ?? [];
  const title = card.title.toLowerCase();
  const text = `${card.title}\n${card.description}`.toLowerCase();
  const touched = touchedPaths(card, files);
  // A card that names its touches is routed on them: its description's
  // words can add weight, but never a sector on their own.
  const hasTouches = card.touches.length > 0;
  const notes: string[] = [];
  const docsOnly = hasTouches && card.touches.every((t) => isDocsTouch(t));
  const wordsScore = (sector: Sector) =>
    !(docsOnly && !DOC_SECTORS.has(sector));
  /** Why the touched paths rule a sector out, when they do. */
  const against = (sector: Sector): string | undefined => {
    if (!hasTouches) return undefined;
    if (docsOnly)
      return DOC_SECTORS.has(sector) ? undefined : "the card only touches docs";
    const lives = SECTOR_SIGNALS[sector].livesIn;
    return lives && !pathHit(lives.paths, touched)
      ? `none of its touches is ${lives.what}`
      : undefined;
  };

  // 1–3. Score each sector: paths, keywords, manifest triggers, profile.
  const scores = new Map<Sector, SectorScore>();
  const evidence = new Map<Sector, Set<Evidence>>();
  const has = (sector: Sector, ...kinds: Evidence[]) =>
    kinds.some((k) => evidence.get(sector)?.has(k));
  const add = (
    sector: Sector,
    points: number,
    reason: string,
    kind: Evidence,
  ) => {
    const s = scores.get(sector) ?? { sector, score: 0, reasons: [] };
    s.score += points;
    s.reasons.push(reason);
    scores.set(sector, s);
    evidence.set(sector, (evidence.get(sector) ?? new Set()).add(kind));
  };
  // The words each sector scored on, so a skill triggering on one of them
  // doesn't count it a second time.
  const scoredWords = new Map<Sector, Set<string>>();
  const scoreWord = (sector: Sector, word: string, ambiguous = false) => {
    if (scoredWords.get(sector)?.has(word.toLowerCase())) return;
    // An ambiguous word is weak evidence wherever it is.
    if (hasWord(title, word))
      add(
        sector,
        ambiguous ? 1 : 2,
        `"${word}" in the title`,
        ambiguous ? "words" : "title",
      );
    else if (hasWord(text, word))
      add(sector, 1, `"${word}" in the description`, "words");
    else return;
    scoredWords.set(
      sector,
      (scoredWords.get(sector) ?? new Set()).add(word.toLowerCase()),
    );
  };
  const isAmbiguous = (sector: Sector, word: string) =>
    SECTOR_SIGNALS[sector].ambiguous?.includes(word.toLowerCase()) === true;
  for (const sector of SECTORS) {
    const signals = SECTOR_SIGNALS[sector];
    const path = pathHit(signals.paths, touched);
    if (path) add(sector, 2, `touches ${path}`, "path");
    if (!wordsScore(sector)) continue;
    for (const word of signals.keywords) scoreWord(sector, word);
  }
  for (const m of manifests.values()) {
    if (m.scope !== "task") continue;
    const path = pathHit(m.triggers.paths, touched);
    for (const sector of m.sectors) {
      if (scores.get(sector)?.reasons.some((r) => r.startsWith("skill ")))
        continue;
      if (path) {
        add(sector, 1, `skill ${m.name} triggers on ${path}`, "path");
        continue;
      }
      if (!wordsScore(sector)) continue;
      // A skill's keyword is still a word in the card: it adds nothing to
      // the sector's own keyword for that word, an ambiguous one waits for
      // the pass below, and one found only in the description is keyword
      // evidence like any other.
      const word = m.triggers.keywords.find(
        (k) =>
          hasWord(text, k) &&
          !isAmbiguous(sector, k) &&
          !scoredWords.get(sector)?.has(k.toLowerCase()),
      );
      if (word)
        add(
          sector,
          1,
          `skill ${m.name} triggers on ${word}`,
          hasWord(title, word) ? "title" : "words",
        );
    }
  }
  // Ambiguous words only add to a sector something else already points at:
  // a word of its own, or a touched path where its work lives.
  for (const sector of SECTORS) {
    const lives = SECTOR_SIGNALS[sector].livesIn;
    if (
      !wordsScore(sector) ||
      !(
        scores.has(sector) ||
        (hasTouches && lives && pathHit(lives.paths, touched))
      )
    )
      continue;
    for (const word of SECTOR_SIGNALS[sector].ambiguous ?? [])
      scoreWord(sector, word, true);
  }
  const isIac = picomatch(IAC_PATHS, { dot: true });
  const iac = files.some((f) => isIac(f));
  if (iac) add("infra", 1, "the repo has infrastructure as code", "repo");

  // Over the threshold isn't enough when the card names its touches: the
  // sector needs a touched path, or a title word with nothing in the paths
  // against it. Description words, and the repo having IaC, only add weight.
  const canEnter = (sector: Sector) =>
    has(sector, "path") ||
    (!against(sector) && (!hasTouches || has(sector, "title")));
  const inSectors = new Set<Sector>(
    [...scores.values()]
      .filter((s) => s.score >= SECTOR_THRESHOLD && canEnter(s.sector))
      .map((s) => s.sector),
  );
  // Profile flags bring in the sector they qualify, alongside it.
  const join = (sector: Sector, reason: string) => {
    if (inSectors.has(sector)) return;
    inSectors.add(sector);
    evidence.set(sector, (evidence.get(sector) ?? new Set()).add("repo"));
    const s = scores.get(sector) ?? { sector, score: 0, reasons: [] };
    s.reasons.push(reason);
    scores.set(sector, s);
  };
  if (inSectors.has("ui") && flags["public-facing"])
    join("a11y", "the profile is public-facing and the task has UI");
  if (inSectors.has("data") && flags["handles-pii"])
    join("legal", "the profile handles PII and the task touches data");

  const ranked = [...scores.values()].sort(
    (a, b) =>
      Number(inSectors.has(b.sector)) - Number(inSectors.has(a.sector)) ||
      b.score - a.score ||
      SECTORS.indexOf(a.sector) - SECTORS.indexOf(b.sector),
  );
  const sectors = ranked
    .filter((s) => inSectors.has(s.sector))
    .map((s) => s.sector);
  const borderline = ranked
    .filter((s) => !inSectors.has(s.sector) && s.score > 0)
    .map((s) => s.sector);
  // Words alone don't hold a route for a person: description words never,
  // title words not when the touched paths rule the sector out.
  const outReasons: Partial<Record<Sector, string>> = {};
  for (const sector of borderline) {
    if (has(sector, "path", "repo")) continue;
    // An ambiguous word in the title is weak evidence, said as such.
    const weakTitle = scores
      .get(sector)
      ?.reasons.some((r) => r.endsWith(" in the title"));
    const why = has(sector, "title")
      ? against(sector)
      : weakTitle
        ? "scored only on ambiguous words and description keywords"
        : KEYWORD_ONLY_REASON;
    if (why) outReasons[sector] = why;
  }
  const decidedOut = borderline.filter((s) => outReasons[s] !== undefined);

  // 4. Phases from the task's type and wording.
  const phases = new Set<SkillPhase>(
    card.type === "feature" || card.type === "spike"
      ? ["brief", "build", "prove", "review"]
      : ["build", "prove", "review"],
  );
  if (DESIGN_WORDS.some((w) => hasWord(text, w))) {
    phases.add("brief");
    phases.add("polish");
  }
  if (card.type === "fix" || FIX_WORDS.some((w) => hasWord(text, w))) {
    phases.delete("brief");
    phases.add("prove");
  }

  // Skills: task-scope manifests in the task's sectors and phases that
  // trigger (or that the card names), best first; requirements, conflicts,
  // the critique fallback and then the cap of four resolved in that order.
  const named = (name: string) => hasWord(text, name);
  const candidates = [...manifests.values()]
    .filter(
      (m) =>
        m.scope === "task" &&
        m.sectors.some((s) => inSectors.has(s)) &&
        m.phases.some((p) => phases.has(p)),
    )
    .map((m) => {
      const path = pathHit(m.triggers.paths, touched) ? 1 : 0;
      const words = m.triggers.keywords.filter((k) => hasWord(text, k));
      // A skill that says where its work lives, on a card whose touches
      // miss it, needs more than a word in the description to load.
      const offPath =
        hasTouches &&
        m.triggers.paths.length > 0 &&
        path === 0 &&
        !words.some((k) => hasWord(title, k));
      const hits = offPath ? 0 : path + words.length;
      // A profile flag ranks a skill that matched; it can't match one alone
      // (every UI task in a public-facing repo isn't a new page).
      const qualified =
        hits > 0 ? m.triggers.flags.filter((f) => flags[f]) : [];
      return { m, named: named(m.name), hits: hits + qualified.length };
    })
    .filter((c) => c.named || c.hits > 0)
    .sort(
      (a, b) =>
        Number(b.named) - Number(a.named) ||
        b.hits - a.hits ||
        rank(a.m.name) - rank(b.m.name) ||
        a.m.name.localeCompare(b.m.name),
    );

  // Why a skill that matched can't load, as plainly as the lock allows.
  const locked = input.locked;
  const unloaded = (name: string) =>
    locked === undefined
      ? "isn't available (not locked, not synced, or blocked at sync)"
      : !locked.has(name)
        ? `isn't locked: run \`rivetari skills add ${manifests.get(name)?.source ?? name}\``
        : "is locked but didn't load (blocked or not synced): run `rivetari skills sync`";
  // The note each skill that couldn't load left, so a sector it would have
  // covered can say which skill it's missing.
  const unloadedNotes = new Map<string, string>();
  if (available.size === 0 && candidates.length > 0) {
    notes.push(
      `no skills are ${locked?.size === 0 ? "locked" : "synced"} in this repo (\`rivetari skills init\`, then \`rivetari skills sync\`); matched: ${candidates.map((c) => c.m.name).join(", ")}`,
    );
    for (const { m } of candidates)
      unloadedNotes.set(m.name, `${m.name} matched but ${unloaded(m.name)}`);
  }
  // Each loadable candidate with everything it requires, best first. Only
  // the cap below decides what's kept, against what it has kept so far, so
  // a skill removed as unavailable never holds a place, and a group the cap
  // cuts neither blocks a conflicting skill nor takes a shared requirement
  // with it.
  const picked: string[][] = [];
  for (const { m } of available.size > 0 ? candidates : []) {
    const group = withRequires(m.name, manifests);
    const missing = group.find((n) => !available.has(n));
    if (missing) {
      const note =
        missing === m.name
          ? `${m.name} matched but ${unloaded(m.name)}`
          : `${m.name} left out: it requires ${missing}, which ${unloaded(missing)}`;
      notes.push(note);
      unloadedNotes.set(m.name, note);
      continue;
    }
    picked.push(group);
  }
  const cap = (groups: readonly string[][]) => {
    const kept: string[] = [];
    const left: string[] = [];
    const conflicting = (name: string) =>
      kept.find(
        (s) =>
          manifests.get(s)?.conflicts.includes(name) ||
          manifests.get(name)?.conflicts.includes(s),
      );
    for (const group of groups) {
      const name = group.at(-1) ?? "";
      const need = group.filter((n) => !kept.includes(n));
      if (need.length === 0) continue;
      const clash = need
        .map((n) => [n, conflicting(n)] as const)
        .find(([, c]) => c);
      if (clash)
        left.push(`${name} left out: ${clash[0]} conflicts with ${clash[1]}`);
      else if (kept.length + need.length > MAX_TASK_SKILLS)
        left.push(
          `${name} left out: it would take the assembly past ${MAX_TASK_SKILLS} skills`,
        );
      else kept.push(...need);
    }
    return { kept, cut: left };
  };
  // The fallback steps aside only for a critique skill that survives the
  // cap without it; otherwise it keeps its place.
  let capped = cap(picked);
  const fallback = picked.findIndex((g) => g.at(-1) === CRITIQUE_FALLBACK);
  if (fallback !== -1) {
    const without = cap(picked.filter((_, i) => i !== fallback));
    if (without.kept.some((s) => CRITIQUE.includes(s))) {
      capped = without;
      notes.push(
        `${CRITIQUE_FALLBACK} left out: a critique skill is already in the assembly`,
      );
    }
  }
  notes.push(...capped.cut);
  const skills = capped.kept;

  const spine = [...manifests.values()]
    .filter(
      (m) =>
        m.scope === "always" &&
        available.has(m.name) &&
        ((m.sectors.some((s) => inSectors.has(s)) &&
          // Browser skills list ui among their sectors: a task without UI
          // gets them only through their own paths, such as e2e specs.
          (!m.sectors.includes("ui") ||
            inSectors.has("ui") ||
            pathHit(m.triggers.paths, touched) !== undefined)) ||
          named(m.name)),
    )
    .map((m) => m.name)
    .sort();

  // A sector with no task skill loaded names the one that matched but
  // couldn't load, even when the spine touches the sector: a short lock
  // reads as one, not as a sector no skill covers.
  const covers = (names: readonly string[], sector: Sector) =>
    names.some((n) => manifests.get(n)?.sectors.includes(sector));
  const gaps = sectors.flatMap((sector) => {
    if (covers(skills, sector)) return [];
    const missed = candidates.find(
      (c) => c.m.sectors.includes(sector) && unloadedNotes.has(c.m.name),
    );
    const note = missed && unloadedNotes.get(missed.m.name);
    if (note) {
      const at = notes.indexOf(note);
      if (at !== -1) notes.splice(at, 1);
      return [`${sector}: ${note}`];
    }
    return covers(spine, sector)
      ? []
      : [
          `${sector}: no vendored skill covers it; the agent works from the spine`,
        ];
  });

  return {
    assembly: {
      task: card.id,
      sectors,
      phases: SKILL_PHASES.filter((p) => phases.has(p)),
      skills,
      spine,
      budget: {
        skill_tokens: skills.reduce(
          (sum, n) => sum + (manifests.get(n)?.tokens ?? 0),
          0,
        ),
        context_tokens: CONTEXT_TOKENS[card.risk],
        steps: STEPS[card.risk],
      },
      checks: [...input.checks],
      proof: proofFor(inSectors, text, touched),
      review: {
        rubric: "default",
        design_pass:
          inSectors.has("ui") && (phases.has("polish") || card.risk === "high"),
        security: inSectors.has("security"),
      },
      stop_and_ask: [...STOP_TRIGGERS, { touches: [...SENSITIVE_PATHS] }],
      gaps,
    },
    scores: ranked,
    borderline,
    decidedOut,
    outReasons,
    notes,
  };
}

function rank(name: string): number {
  const i = CRITIQUE.indexOf(name);
  return i === -1 ? CRITIQUE.length : i;
}

/** A skill and everything it requires, requirements first. */
function withRequires(
  name: string,
  manifests: ReadonlyMap<string, Manifest>,
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const requires = manifests.get(name)?.requires ?? [];
  return [...requires.flatMap((r) => withRequires(r, manifests, seen)), name];
}

/** The proof a tool produces for this task, most specific sector first. */
function proofFor(
  sectors: ReadonlySet<Sector>,
  text: string,
  touched: readonly string[],
): ProofType {
  if (sectors.has("ui")) return "ui-screenshots";
  if (sectors.has("infra")) return "infra-plan";
  if (
    sectors.has("data") &&
    (SCHEMA_WORDS.some((w) => hasWord(text, w)) ||
      pathHit(["**/migrations/**", "**/*.sql", "**/schema.prisma"], touched))
  )
    return "migration-dry-run";
  if (
    sectors.has("api") &&
    (["endpoint", "openapi", "graphql", "contract"].some((w) =>
      hasWord(text, w),
    ) ||
      pathHit(["**/*.graphql", "**/openapi.*", "**/swagger.*"], touched))
  )
    return "api-contract";
  if (sectors.size > 0 && [...sectors].every((s) => s === "docs"))
    return "docs-render";
  return "test-run";
}

/**
 * Problems with an assembly a human may have edited: the schema, then the
 * rules routing guarantees — skills exist, are task-scope and available,
 * don't conflict, bring what they require, one critique skill; spine skills
 * are always-scope; every check is one the judge can run.
 */
export function validateAssembly(
  input: unknown,
  context: {
    task: string;
    manifests: ReadonlyMap<string, Manifest>;
    available: ReadonlySet<string>;
    checks: readonly string[];
  },
): { assembly?: Assembly; problems: string[] } {
  const parsed = AssemblySchema.safeParse(input);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(assembly)"}: ${i.message}`,
      ),
    };
  }
  const a = parsed.data;
  const { manifests, available } = context;
  const problems: string[] = [];
  if (a.task !== context.task)
    problems.push(`task is ${a.task}, not ${context.task}`);
  // A conflict counts from either side, reported once per pair.
  const clashes = new Set<string>();
  for (const name of a.skills) {
    for (const other of a.skills) {
      if (
        name !== other &&
        manifests.get(name)?.conflicts.includes(other) === true
      )
        clashes.add([name, other].sort().join(" conflicts with "));
    }
  }
  for (const name of a.skills) {
    const m = manifests.get(name);
    if (!m) problems.push(`skills: no manifest for ${name}`);
    else if (m.scope !== "task")
      problems.push(`skills: ${name} is a spine skill; list it under spine`);
    else if (!available.has(name))
      problems.push(`skills: ${name} isn't available (lock and sync it first)`);
    for (const r of m?.requires ?? []) {
      if (!a.skills.includes(r)) problems.push(`skills: ${name} requires ${r}`);
    }
  }
  for (const clash of [...clashes].sort()) problems.push(`skills: ${clash}`);
  if (a.skills.filter((s) => CRITIQUE.includes(s)).length > 1)
    problems.push("skills: one critique skill per task");
  if (new Set(a.skills).size !== a.skills.length)
    problems.push("skills: listed twice");
  for (const name of a.spine) {
    const m = manifests.get(name);
    if (!m || m.scope !== "always")
      problems.push(`spine: ${name} isn't an always-scope skill`);
    else if (!available.has(name))
      problems.push(`spine: ${name} isn't available (lock and sync it first)`);
  }
  const tokens = a.skills.reduce(
    (sum, n) => sum + (manifests.get(n)?.tokens ?? 0),
    0,
  );
  if (a.budget.skill_tokens !== tokens)
    problems.push(
      `budget.skill_tokens is ${a.budget.skill_tokens}; the skills add up to ${tokens}`,
    );
  for (const id of a.checks) {
    if (!context.checks.includes(id))
      problems.push(`checks: ${id} isn't a check the judge can run`);
  }
  return problems.length > 0 ? { problems } : { assembly: a, problems };
}
