// What a task looks like in each sector, for the router. Manifests only
// describe the skills that exist, and some sectors (data, api) have none, so
// the router carries its own signals and uses manifest triggers on top.
import type { Sector } from "@arynbht/rivetari-registry";

export interface SectorSignals {
  /** Matched as whole words in the card's title and description. */
  keywords: readonly string[];
  /**
   * Words that name other things too: a signal's "transition", a layout's
   * "table". They count only alongside other evidence for the sector, never
   * on their own.
   */
  ambiguous?: readonly string[];
  /** Matched against the card's `touches` and the repo files they cover. */
  paths: readonly string[];
  /**
   * Where the sector's work lives, and what to call it. A card that names its
   * touches with none of them here can't bring the sector in on words: a
   * library card that says "transition" isn't animating anything.
   */
  livesIn?: { paths: readonly string[]; what: string };
}

const UI_FILES = [
  "**/*.css",
  "**/*.scss",
  "**/*.tsx",
  "**/*.jsx",
  "**/*.vue",
  "**/*.svelte",
  "**/*.html",
  "**/components/**",
  "**/pages/**",
  "app/**/page.*",
];
const UI_CODE = { paths: UI_FILES, what: "UI code" };
const TEST_FILES = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.e2e.*",
  "e2e/**",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];
const DOC_FILES = ["**/*.md", "**/*.mdx", "docs/**"];

export const SECTOR_SIGNALS: Record<Sector, SectorSignals> = {
  ui: {
    keywords: [
      "ui",
      "page",
      "component",
      "layout",
      "redesign",
      "styling",
      "css",
      "theme",
      "button",
      "modal",
      "dialog",
      "navbar",
      "sidebar",
      "dark mode",
      "responsive",
      "frontend",
    ],
    ambiguous: ["design", "screen"],
    paths: UI_FILES,
    livesIn: UI_CODE,
  },
  motion: {
    keywords: ["animation", "animate", "motion", "easing", "keyframes"],
    ambiguous: ["transition", "spring"],
    paths: [],
    livesIn: UI_CODE,
  },
  api: {
    keywords: [
      "api",
      "endpoint",
      "route handler",
      "rest api",
      "graphql",
      "openapi",
      "webhook",
      "resolver",
      "controller",
      "n+1",
    ],
    paths: [
      "**/api/**",
      "**/routes/**",
      "**/handlers/**",
      "**/controllers/**",
      "**/resolvers/**",
      "**/*.graphql",
      "**/openapi.*",
      "**/swagger.*",
    ],
  },
  data: {
    keywords: [
      "database",
      "db",
      "sql",
      "migration",
      "orm",
      "n+1",
      "prisma",
      "postgres",
    ],
    ambiguous: ["table", "column", "query", "seed"],
    paths: [
      "**/migrations/**",
      "**/*.sql",
      "**/schema.prisma",
      "prisma/**",
      "**/models/**",
      "**/db/**",
      "**/repositories/**",
    ],
  },
  infra: {
    keywords: [
      "terraform",
      "infra",
      "infrastructure",
      "iac",
      "deploy",
      "deployment",
      "kubernetes",
      "k8s",
      "helm",
      "docker",
      "dockerfile",
      "pulumi",
    ],
    paths: [
      "**/*.tf",
      "**/*.tfvars",
      "**/Dockerfile",
      "infra/**",
      "deploy/**",
      "k8s/**",
      "helm/**",
    ],
  },
  security: {
    keywords: [
      "security",
      "auth",
      "authentication",
      "authorization",
      "login",
      "password",
      "secret",
      "csrf",
      "xss",
      "sql injection",
      "vulnerability",
      "cve",
      "oauth",
      "encryption",
    ],
    ambiguous: ["injection", "permission"],
    paths: ["**/auth/**", "**/security/**", "**/crypto/**"],
  },
  testing: {
    keywords: ["test", "e2e", "flaky", "coverage", "playwright"],
    paths: ["**/*.test.*", "**/*.spec.*", "e2e/**", "**/__tests__/**"],
    livesIn: { paths: TEST_FILES, what: "a test" },
  },
  a11y: {
    keywords: [
      "accessibility",
      "a11y",
      "wcag",
      "aria",
      "screen reader",
      "keyboard",
      "contrast",
    ],
    paths: [],
    livesIn: UI_CODE,
  },
  perf: {
    keywords: [
      "performance",
      "perf",
      "slow",
      "latency",
      "bundle size",
      "lighthouse",
      "memory leak",
      "caching",
    ],
    paths: [],
  },
  docs: {
    keywords: [
      "docs",
      "documentation",
      "readme",
      "changelog",
      "tutorial",
      "typo",
    ],
    ambiguous: ["guide"],
    paths: DOC_FILES,
    livesIn: { paths: DOC_FILES, what: "docs" },
  },
  product: {
    keywords: ["prd", "requirements", "roadmap", "discovery", "user story"],
    paths: [],
  },
  legal: {
    keywords: [
      "privacy",
      "gdpr",
      "ccpa",
      "hipaa",
      "dsar",
      "consent",
      "cookie banner",
      "data retention",
      "terms of service",
    ],
    paths: [],
  },
  workflow: {
    keywords: ["ci", "github actions"],
    ambiguous: ["workflow", "release"],
    paths: [".github/**"],
  },
  observability: {
    keywords: [
      "logging",
      "metrics",
      "tracing",
      "telemetry",
      "alert",
      "alerting",
      "dashboard",
      "slo",
      "monitoring",
    ],
    paths: [],
  },
};

/** Files that mean the repo has infrastructure as code (infra joins). */
export const IAC_PATHS = [
  "**/*.tf",
  "**/*.tfvars",
  "**/Pulumi.yaml",
  "**/cdk.json",
  "**/*.bicep",
];

/** Paths that pause the agent whatever the task (`stop_and_ask.touches`). */
export const SENSITIVE_PATHS = [
  "**/auth/**",
  "**/billing/**",
  "**/payments/**",
];

/** Words that shape the phases. */
export const DESIGN_WORDS = ["redesign", "polish", "new page"];
export const FIX_WORDS = ["fix", "bug", "regression", "broken"];
/** Words that mean the schema changes, so data's proof is a migration dry-run. */
export const SCHEMA_WORDS = [
  "migration",
  "schema change",
  "new table",
  "new column",
  "add column",
  "drop column",
];
