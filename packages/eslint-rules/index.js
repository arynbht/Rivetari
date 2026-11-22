import noBanned from "./no-banned.js";
import noSpecSectionRefs from "./no-spec-section-refs.js";
import noWritesToWorkflows from "./no-writes-to-workflows.js";

export default {
  meta: { name: "factory" },
  rules: {
    "no-banned": noBanned,
    "no-spec-section-refs": noSpecSectionRefs,
    "no-writes-to-workflows": noWritesToWorkflows,
  },
};
