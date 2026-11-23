import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProgram } from "./cli.js";

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const sub = (parent: Command, name: string): Command => {
  const found = parent.commands.find((c) => c.name() === name);
  if (!found) throw new Error(`no ${name} command`);
  return found;
};

describe("rivetari hook guard --help", () => {
  const hook = sub(buildProgram(), "hook");
  const guard = sub(hook, "guard");

  it("names everything the guard refuses", () => {
    const help = flat(guard.helpInformation());
    for (const refused of [
      ".rivetari/**",
      "primary checkout on the default branch",
      "shell commands that write them",
      "force push",
      "remote delete",
      "git reset --hard",
      "git clean -f",
      "git branch -D",
    ])
      expect(help).toContain(refused);
  });

  it("is listed under rivetari hook --help with the same description", () => {
    const help = flat(hook.helpInformation());
    expect(help).toContain(`guard ${flat(guard.description())}`);
  });
});
