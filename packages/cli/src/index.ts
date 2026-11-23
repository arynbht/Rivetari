// @arynbht/rivetari (CLI)
// commander-based CLI over the engine.
export const PACKAGE = "@arynbht/rivetari" as const;

export { buildProgram, run } from "./cli.js";
export { runAudit } from "./commands/audit.js";
export {
  exitCodeFor,
  renderReport,
  summarize,
  type Summary,
} from "./report.js";
