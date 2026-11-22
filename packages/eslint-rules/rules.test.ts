import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import noBanned from "./no-banned.js";
import noSpecSectionRefs from "./no-spec-section-refs.js";
import noWritesToWorkflows from "./no-writes-to-workflows.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

tester.run("no-spec-section-refs", noSpecSectionRefs, {
  valid: [
    "// Stop and ask before adding a dependency.\nexport const a = 1;",
    'const label = "see §10 of the spec";',
    "/** The judge runs on a clean clone. */\nexport function judge() {}",
  ],
  invalid: [
    {
      code: "// Write beside, never over (§10).\nexport const a = 1;",
      errors: [{ messageId: "section", data: { section: "§10" } }],
    },
    {
      code: "/**\n * The hooks fail closed (FACTORY_V2 § 5.3).\n */\nexport const b = 2;",
      errors: [{ messageId: "section", data: { section: "§5.3" } }],
    },
  ],
});

tester.run("no-writes-to-workflows", noWritesToWorkflows, {
  valid: [
    'await writeFile(join(root, ".factory", "profile.yml"), text);',
    'await writeFile(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), text);',
    'const rel = ".github/workflows/factory.yml";\nlog(rel);',
    {
      code: 'await writeFile(join(root, ".github/workflows/ci.yml"), text);',
      filename: "/repo/packages/cli/src/commands/init.ts",
      options: [{ allow: ["packages/cli/src/commands/init.ts"] }],
    },
  ],
  invalid: [
    {
      code: 'await writeFile(join(root, ".github", "workflows", "factory.factory.yml"), text);',
      errors: [{ messageId: "workflows" }],
    },
    {
      code: "await fs.writeFile(`${root}/.github/workflows/${name}.bak`, text);",
      errors: [{ messageId: "workflows" }],
    },
    {
      code: 'await writeBeside(root, ".github/workflows/factory.yml", text, false);',
      errors: [{ messageId: "workflows" }],
    },
    {
      code: 'copyFileSync(src, root + "/.github/workflows/extra.yml");',
      errors: [{ messageId: "workflows" }],
    },
  ],
});

tester.run("no-banned", noBanned, {
  valid: [
    {
      code: "const total = retrieval(x);",
      filename: "src/a.ts",
      options: [
        {
          patterns: [
            {
              id: "no-eval",
              pattern: String.raw`(?<![\w.$])eval\s*\(`,
              files: "**/*.ts",
              why: "w",
            },
          ],
        },
      ],
    },
    {
      code: "const v = eval(x);",
      filename: "src/sandbox/a.ts",
      options: [
        {
          patterns: [
            {
              id: "no-eval",
              pattern: String.raw`(?<![\w.$])eval\s*\(`,
              files: "**/*.ts",
              allow: ["src/sandbox/**"],
              why: "w",
            },
          ],
        },
      ],
    },
    {
      code: "const v = eval(x);",
      filename: "src/a.py",
      options: [
        {
          patterns: [
            {
              id: "no-eval",
              pattern: String.raw`(?<![\w.$])eval\s*\(`,
              files: "**/*.{js,ts}",
              why: "w",
            },
          ],
        },
      ],
    },
  ],
  invalid: [
    {
      code: "const a = 1;\nconst v = eval(x);",
      filename: "src/a.ts",
      options: [
        {
          patterns: [
            {
              id: "no-eval",
              pattern: String.raw`(?<![\w.$])eval\s*\(`,
              files: "**/*.{js,ts}",
              why: "parse it",
            },
          ],
        },
      ],
      errors: [
        {
          messageId: "banned",
          data: { id: "no-eval", why: "parse it" },
          line: 2,
        },
      ],
    },
  ],
});
