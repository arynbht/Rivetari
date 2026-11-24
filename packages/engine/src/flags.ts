// The risk flags a repo shows on disk. Most flags are facts about the people a
// product serves (has-users, handles-pii, eu-users) that no file states, so
// only three are read here, each from something a repo can't have by accident:
// an open-source license, an AI SDK it depends on, and a packager that builds
// binaries to hand out. A flag that isn't found isn't taken to be false: the
// desktop's Project view only suggests adding what it can show.
import type { AuditContext } from "./context.js";

export interface InferredFlag {
  flag: "open-source" | "uses-ai" | "distributes-binaries";
  /** What shows it, said so a person can check: "LICENSE is the MIT License". */
  evidence: string;
}

type RepoFiles = Pick<AuditContext, "glob" | "readFile">;

// Manifests are read at the root and up to two directories down, as the stack
// detector reads them, so a monorepo's packages count.
const DEPTHS = ["", "*/", "*/*/"];
const at = (...names: string[]) =>
  DEPTHS.flatMap((d) => names.map((n) => `${d}${n}`));

/**
 * Text each license's file carries near its top. Only the start of a file is
 * read, so a proprietary LICENSE that quotes a dependency's MIT notice further
 * down doesn't count.
 */
const LICENSE_TEXTS: [RegExp, string][] = [
  [
    /\bMIT License\b|Permission is hereby granted, free of charge/i,
    "the MIT License",
  ],
  [/\bApache License\b/i, "the Apache License"],
  [/Redistribution and use in source and binary forms/i, "a BSD license"],
  [/\bISC License\b/i, "the ISC License"],
  [/GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i, "a GNU license"],
  [/Mozilla Public License/i, "the Mozilla Public License"],
  [/Eclipse Public License/i, "the Eclipse Public License"],
  [/This is free and unencumbered software/i, "the Unlicense"],
];
const LICENSE_HEAD = 2000;

/** SPDX ids package.json's `license` can name for an open-source license. */
const OPEN_SPDX =
  /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC|0BSD|MPL-2\.0|EPL-2\.0|Unlicense|(A|L)?GPL-[23]\.0(-only|-or-later)?)$/i;

/** npm packages that call a model. */
const AI_PACKAGES = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "openai",
  "ai",
  "langchain",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "@mistralai/mistralai",
  "ollama",
  "replicate",
  "@huggingface/inference",
];
const AI_SCOPES = ["@ai-sdk/", "@langchain/"];

/** Python distributions that call a model. */
const AI_PYTHON = [
  "anthropic",
  "openai",
  "langchain",
  "llama-index",
  "google-generativeai",
  "google-genai",
  "cohere",
  "mistralai",
  "ollama",
  "transformers",
];

/** Config files of tools that package an app as binaries to download. */
const PACKAGER_FILES = at(
  "electron-builder.yml",
  "electron-builder.yaml",
  "electron-builder.json",
  "electron-builder.json5",
  "electron-builder.toml",
  "forge.config.js",
  "forge.config.cjs",
  "forge.config.mjs",
  "forge.config.ts",
  ".goreleaser.yml",
  ".goreleaser.yaml",
  "goreleaser.yml",
  "goreleaser.yaml",
  "tauri.conf.json",
  "src-tauri/tauri.conf.json",
  "dist-workspace.toml",
);

/** npm packages that package an app as binaries. */
const PACKAGERS = ["electron-builder", "@electron-forge/cli", "@yao-pkg/pkg"];

interface Pkg {
  name?: unknown;
  license?: unknown;
  private?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function parsePkg(text: string | null): Pkg | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Pkg) : null;
  } catch {
    // A package.json that won't parse says nothing about its flags.
    return null;
  }
}

const depNames = (deps: unknown): string[] =>
  deps && typeof deps === "object" ? Object.keys(deps) : [];

async function openSource(repo: RepoFiles): Promise<InferredFlag | null> {
  const files = (await repo.glob(["LICENSE*", "LICENCE*", "COPYING*"])).sort();
  for (const file of files) {
    const text = await repo.readFile(file);
    if (text === null) continue;
    const head = text.slice(0, LICENSE_HEAD);
    const found = LICENSE_TEXTS.find(([re]) => re.test(head));
    if (found)
      return { flag: "open-source", evidence: `${file} is ${found[1]}` };
  }
  // A private package's license field is often the template's default, so it
  // only counts for a package that's published.
  const pkg = parsePkg(await repo.readFile("package.json"));
  if (
    pkg &&
    pkg.private !== true &&
    typeof pkg.license === "string" &&
    OPEN_SPDX.test(pkg.license)
  )
    return {
      flag: "open-source",
      evidence: `package.json's license is ${pkg.license}`,
    };
  return null;
}

async function usesAi(repo: RepoFiles): Promise<InferredFlag | null> {
  // Only runtime dependencies count: an SDK used in a test or a script isn't
  // the product using AI.
  for (const file of (await repo.glob(at("package.json"))).sort()) {
    const pkg = parsePkg(await repo.readFile(file));
    const hit = depNames(pkg?.dependencies).find(
      (d) => AI_PACKAGES.includes(d) || AI_SCOPES.some((s) => d.startsWith(s)),
    );
    if (hit) return { flag: "uses-ai", evidence: `${file} depends on ${hit}` };
  }
  const python = await repo.glob(
    at(
      "pyproject.toml",
      "requirements.txt",
      "setup.py",
      "setup.cfg",
      "Pipfile",
    ),
  );
  for (const file of python.sort()) {
    const text = ((await repo.readFile(file)) ?? "").toLowerCase();
    const hit = AI_PYTHON.find((dep) =>
      new RegExp(`(^|[^a-z0-9_.-])${dep}([^a-z0-9_.-]|$)`, "m").test(text),
    );
    if (hit) return { flag: "uses-ai", evidence: `${file} names ${hit}` };
  }
  return null;
}

async function distributesBinaries(
  repo: RepoFiles,
): Promise<InferredFlag | null> {
  const config = (await repo.glob(PACKAGER_FILES)).sort()[0];
  if (config)
    return {
      flag: "distributes-binaries",
      evidence: `${config} packages binaries`,
    };
  for (const file of (await repo.glob(at("package.json"))).sort()) {
    const pkg = parsePkg(await repo.readFile(file));
    const hit = [
      ...depNames(pkg?.dependencies),
      ...depNames(pkg?.devDependencies),
    ].find((d) => PACKAGERS.includes(d));
    if (hit)
      return {
        flag: "distributes-binaries",
        evidence: `${file} builds with ${hit}`,
      };
  }
  return null;
}

/** The flags the repo shows, each with what shows it, in FLAG_KEYS order. */
export async function inferFlags(repo: RepoFiles): Promise<InferredFlag[]> {
  const found = await Promise.all([
    usesAi(repo),
    openSource(repo),
    distributesBinaries(repo),
  ]);
  return found.filter((f): f is InferredFlag => f !== null);
}
