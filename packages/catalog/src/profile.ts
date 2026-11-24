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
       * Viewport widths in CSS pixels the UI proof shoots and runs axe at,
       * before and after (default 375, 768 and 1280). 375, 768 and 1280 are
       * named sm, md and lg in file names; any other width is w<width>.
       */
      widths: z
        .array(z.number().int().min(200).max(3840))
        .min(1)
        .max(8)
        .refine((w) => new Set(w).size === w.length, "widths repeat")
        .optional(),
      /**
       * What shows a page has really rendered, so no screenshot is of a
       * loading state: a Playwright selector (CSS, or `text=Session summary`)
       * that only exists once the page's real data is on screen. One string
       * applies to every page; a map names one per page, keyed by the page's
       * path (`/cloud/trends`), a glob of it (`/cloud/sessions/*`), or `*`
       * for every other page. An exact path wins, then the first glob that
       * matches. Unset for a page, the proof waits for the network to go
       * idle, then for no visible loading marker (aria-busy, a skeleton,
       * spinner or loading class, an indeterminate progressbar, "Loading…"
       * text), then for the DOM to stop changing for half a second. A page
       * that never gets there fails the proof; it is never shot and passed.
       */
      ready: z
        .union([
          z.string().min(1),
          z.record(z.string().min(1), z.string().min(1)),
        ])
        .optional(),
      /** Seconds each page has to really render once it loads (default 30). */
      render_timeout: z.number().int().positive().max(600).optional(),
      /**
       * Build and check the container for an infra-plan proof: `docker build`
       * of `file` in `context`, then `docker run` with `port` published on
       * the task's port, then a GET of `path` that must answer below 400
       * within `timeout` seconds. Without `port` the image is built but not
       * run. With no Docker on the machine, or no `port`, the proof says what
       * wasn't checked, marks it unverified and fails: a check that can't run
       * is never passed. Unset: no container is built.
       */
      docker: z
        .strictObject({
          /** The Dockerfile, from the repo root (default Dockerfile). */
          file: z.string().min(1).optional(),
          /** The build context, from the repo root (default the root). */
          context: z.string().min(1).optional(),
          /** The port the container serves on. */
          port: z.number().int().min(1).max(65535).optional(),
          /** The path to GET (default /). */
          path: z.string().startsWith("/").optional(),
          /** Seconds for the container to answer (default 60). */
          timeout: z.number().int().positive().max(600).optional(),
        })
        .optional(),
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
