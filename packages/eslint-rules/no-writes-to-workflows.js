const WRITERS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "rename",
  "renameSync",
  "createWriteStream",
  "outputFile",
  "writeBeside",
  "writeReplacing",
]);

const WORKFLOWS = /(^|\/)\.github\/workflows(\/|$)/;

function parts(node) {
  if (!node) return [];
  if (node.type === "Literal" && typeof node.value === "string")
    return [node.value];
  if (node.type === "TemplateLiteral")
    return [node.quasis.map((q) => q.value.cooked ?? "").join("*")];
  if (node.type === "BinaryExpression" && node.operator === "+")
    return [[...parts(node.left), ...parts(node.right)].join("")];
  if (node.type === "CallExpression")
    return [node.arguments.flatMap(parts).join("/")];
  return ["*"];
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Only allowed modules write into .github/workflows: every file there runs on GitHub, so a stray sibling or backup becomes a live workflow",
    },
    messages: {
      workflows:
        "This writes into .github/workflows, where every file runs as a workflow on GitHub (a sibling or backup written there goes live). Write it somewhere else, or add this file to the rule's allow list after a person agrees.",
    },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const allow = context.options[0]?.allow ?? [];
    const file = context.filename.split("\\").join("/");
    if (allow.some((suffix) => file.endsWith(suffix))) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !WRITERS.has(name)) return;
        const target = node.arguments
          .slice(0, 2)
          .flatMap(parts)
          .map((p) => p.split("\\").join("/"));
        if (target.some((p) => WORKFLOWS.test(p)))
          context.report({ node, messageId: "workflows" });
      },
    };
  },
};
