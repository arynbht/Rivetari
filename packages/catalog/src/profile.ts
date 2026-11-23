// The profile schema. A profile (`.rivetari/profile.yml`) describes what a project
// is and the risks it carries, so the engine can decide which controls apply.
import { z } from "zod";

import {
  FLAG_KEYS,
  LANE_KEYS,
  PHASE_KEYS,
  PROJECT_TYPES,
  SEVERITIES,
} from "./taxonomy.js";

// Flags and lane toggles are explicit optional booleans so an unknown key is
// rejected (strict), catching typos that would otherwise silently mis-scope.
const FlagsSchema = z
  .strictObject(
    Object.fromEntries(
      FLAG_KEYS.map((key) => [key, z.boolean().optional()]),
    ) as Record<(typeof FLAG_KEYS)[number], z.ZodOptional<z.ZodBoolean>>,
  )
  .default({});

const LanesSchema = z
  .strictObject(
    Object.fromEntries(
      LANE_KEYS.map((key) => [key, z.boolean().optional()]),
    ) as Record<(typeof LANE_KEYS)[number], z.ZodOptional<z.ZodBoolean>>,
  )
  .optional();

/**
 * Who the project belongs to, read by templates (LICENSE, CODEOWNERS, SECURITY.md)
 * so no scaffold ships a placeholder like `@OWNER` or `security@example.com`.
 */
const ProjectSchema = z
  .strictObject({
    /** SPDX license id, e.g. MIT or Apache-2.0. */
    license: z.string().min(1).optional(),
    /** GitHub handle (`@user` or `@org/team`) that owns the code. */
    owner: z.string().min(1).optional(),
    /** Copyright holder; defaults to the project name. */
    "copyright-holder": z.string().min(1).optional(),
    /** Where to report vulnerabilities: an email or a URL. */
    "security-contact": z.string().min(1).optional(),
  })
  .optional();

export const AUTONOMY_LEVELS = [
  "supervised",
  "review-at-pr",
  "unattended",
] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const ProfileSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  type: z.enum(PROJECT_TYPES),
  stack: z.array(z.string()).default([]),
  /** Current lifecycle phase; set by `rivetari init`, inferred in M6. */
  phase: z.enum(PHASE_KEYS).optional(),
  flags: FlagsSchema,
  /** Optional per-lane on/off toggle; a lane absent here defaults to on. */
  lanes: LanesSchema,
  "severity-floor": z.enum(SEVERITIES).default("low"),
  autonomy: z.enum(AUTONOMY_LEVELS).default("supervised"),
  project: ProjectSchema,
  generated: z.array(z.string().min(1)).optional(),
  /**
   * Keep a floorplan, the floorplan skill's map of the codebase in
   * floorplan/: drawn at init, updated when a task merges. `rivetari init`
   * writes true; absent (every profile from before it) is off.
   */
  floorplan: z.boolean().optional(),
  ai: z
    .strictObject({
      /** Model for drafting and agent work. */
      model: z.string().min(1).optional(),
      /** Model for the judge's review; defaults to a different one from `model`. */
      judge_model: z.string().min(1).optional(),
    })
    .optional(),
  /** How the proof runner serves the app for UI proof. */
  proof: z
    .strictObject({
      /** The command that serves the app; it gets PORT in its environment. */
      start: z.string().min(1).optional(),
      /** Where it serves; `{port}` is replaced. Default http://localhost:{port}. */
      url: z.string().min(1).optional(),
      /** Seconds to wait for the URL to answer (default 90). */
      ready_timeout: z.number().int().positive().optional(),
      /**
       * Signing in, for pages behind it. Once the URL answers and before any
       * screenshot, the proof runner opens a browser at the app and runs
       * `script`, then saves the browser's cookies and local storage (a
       * Playwright storageState, in a temp dir, never committed) and shoots
       * every page, before and after, with it. The script is a JavaScript
       * module at a path from the repo root, read from the checkout the
       * profile is, whose default export is
       * `async ({ page, context, baseURL }) => {}`: Playwright's page and
       * context (with `baseURL` set, so `page.goto("/login")` works) from
       * rivetari's own Playwright, so the repo needn't install it. It runs
       * with PORT and URL in its environment. A script that throws, or that
       * leaves no cookies or local storage behind, fails the proof.
       */
      auth: z
        .strictObject({
          script: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
  /** What CI may spend, and whether it may lean on the judge. */
  ci: z
    .strictObject({
      /**
       * GitHub Actions minutes the repo means to spend in a calendar month
       * (UTC), counted per job and rounded up to the minute as GitHub bills.
       * `rivetari doctor` warns at 75% and the status issue shows the month
       * so far against it. Unset: nothing is counted.
       */
      budget_minutes_per_month: z.number().int().positive().optional(),
      /**
       * Post a `rivetari/judge` check run on a shipped task's head commit when
       * the judge passed it, which CI can trust to skip lint, typecheck and
       * tests the judge already ran. Unset: true when the repo belongs to the
       * account Rivetari's App is registered to, false on anyone else's.
       */
      trust_judge: z.boolean().optional(),
    })
    .optional(),
  quality: z
    .strictObject({
      /**
       * Minimum line coverage (%). Unset: the baseline Rivetari recorded at
       * the first measured run (`.rivetari/quality.json`), which only ratchets up.
       */
      coverage: z.number().min(0).max(100).optional(),
      "no-new-comments": z.boolean().optional(),
    })
    .optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;
