// `rivetari metrics` lives in the runtime, so the desktop shell's History view
// reads the same numbers from the same functions; the command is these.
export {
  costFlags,
  type MetricsFlags,
  renderCost,
  renderFindings,
  renderLadder,
  runMetrics,
  type RunMetricsOptions,
  verificationLines,
} from "@arynbht/rivetari-runtime";
