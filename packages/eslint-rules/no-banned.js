function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      out += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "No pattern from the repo's banned list (.factory/banned.json), which the judge also enforces on every change",
    },
    messages: {
      banned: "{{id}} is banned here: {{why}}",
    },
    schema: [
      {
        type: "object",
        properties: {
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                pattern: { type: "string" },
                files: { type: "string" },
                allow: { type: "array", items: { type: "string" } },
                why: { type: "string" },
              },
              required: ["id", "pattern", "why"],
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const file = context.filename
      .split("\\")
      .join("/")
      .replace(`${context.cwd.split("\\").join("/")}/`, "");
    const rules = (context.options[0]?.patterns ?? []).filter(
      (p) =>
        globToRegExp(p.files ?? "**/*").test(file) &&
        !(p.allow ?? []).some((a) => globToRegExp(a).test(file)),
    );
    if (rules.length === 0) return {};
    return {
      Program() {
        const lines = context.sourceCode.lines;
        for (const p of rules) {
          const re = new RegExp(p.pattern);
          lines.forEach((line, i) => {
            if (re.test(line))
              context.report({
                loc: {
                  start: { line: i + 1, column: 0 },
                  end: { line: i + 1, column: line.length },
                },
                messageId: "banned",
                data: { id: p.id, why: p.why },
              });
          });
        }
      },
    };
  },
};

export { globToRegExp };
