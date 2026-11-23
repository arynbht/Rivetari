// A stand-in for the floorplan skill's scripts in tests. Every call is logged
// to calls.log beside the skill (name, flags, whether it ran unattended and
// whether a credential reached it), and each prints a short version of the JSON
// the real script prints.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skill = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const write = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
};
export const exists = (p) => fs.existsSync(p);

export function run(name, act) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  fs.appendFileSync(
    path.join(skill, "calls.log"),
    `${name} ${flags.join(" ")} unattended=${process.env.FLOORPLAN_UNATTENDED ?? ""} token=${process.env.GITHUB_TOKEN || process.env.GITHUB_PAT ? "leaked" : "none"}\n`,
  );
  const out = act({ root, map: path.join(root, "floorplan") });
  process.stdout.write(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}
