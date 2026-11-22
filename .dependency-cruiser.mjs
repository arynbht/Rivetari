export default {
  forbidden: [
    {
      name: "engine-stays-below-runtime-and-cli",
      severity: "error",
      from: { path: "^packages/engine/" },
      to: { path: "^(packages/(runtime|cli)/|@arynbht/factory(-runtime)?$)" },
    },
    {
      name: "agent-doesnt-touch-the-ledger",
      severity: "error",
      from: { path: "^packages/runtime/src/agent/" },
      to: { path: "^packages/runtime/(src|dist)/task/ledger\\.[jt]s$" },
    },
    {
      name: "only-cli-imports-runtime",
      severity: "error",
      from: { path: "^(packages|apps)/", pathNot: "^packages/(runtime|cli)/" },
      to: { path: "^(packages/runtime/|@arynbht/factory-runtime$)" },
    },
    {
      name: "only-action-imports-cli",
      severity: "error",
      from: { path: "^(packages|apps)/", pathNot: "^packages/(cli|action)/" },
      to: { path: "^(packages/cli/|@arynbht/factory$)" },
    },
    {
      name: "catalog-imports-no-workspace-package",
      severity: "error",
      from: { path: "^packages/catalog/" },
      to: {
        path: "^(packages/(engine|registry|runtime|cli)/|@arynbht/factory(-engine|-registry|-runtime)?$)",
      },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules", "/dist/"] },
    exclude: { path: ["/dist/", "/out/", "/coverage/", "\\.d\\.ts$"] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
