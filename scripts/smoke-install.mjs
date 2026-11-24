// Install the published CLI the way a new user does, from an empty folder with
// nothing but a GitHub Packages token, and check it works: `rivetari --help`,
// `rivetari init --yes --type web-app` in a fresh git repo, `rivetari skills sync`,
// then `rivetari doctor`.
//
//   NPM_TOKEN=<classic PAT with read:packages> node scripts/smoke-install.mjs [options]
//
//   --version <v>   the @arynbht/rivetari version to install (default: latest)
//   --from <dir>    install the .tgz files in <dir> (from `pnpm pack`) instead of
//                   the registry, to check a release before it's published
//   --keep          leave the temp folder behind to poke at
//
// Everything lives in one temp folder: the .npmrc, npm's cache, the install
// and the repo, so nothing on this machine (a logged-in npm, a warm cache, a
// global rivetari) can make a broken package look fine. The install is a local
// one in that folder, put first on PATH, rather than `npm i -g`, so it never
// touches the machine's global packages. init draws the floorplan with Claude,
// which takes a few minutes and a paid model call.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    version: { type: "string", default: "latest" },
    from: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

// doctor's checks that depend on the package itself. claude and github depend
// on the machine, so they're reported but don't fail the smoke test.
const MUST_PASS = ["git", "profile", "hooks"];
const MUST_NOT_FAIL = ["skills"];

const root = mkdtempSync(join(tmpdir(), "rivetari-smoke-"));
const prefix = join(root, "install");
const repo = join(root, "repo");
const isWindows = process.platform === "win32";

const env = {
  ...process.env,
  npm_config_userconfig: join(root, ".npmrc"),
  npm_config_globalconfig: join(root, "global.npmrc"),
  npm_config_cache: join(root, "npm-cache"),
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  PATH: `${join(prefix, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
};

function run(cmd, cmdArgs, cwd) {
  process.stdout.write(`\n$ ${[cmd, ...cmdArgs].join(" ")}\n`);
  // npm and the installed bin are .cmd shims on Windows, which need a shell.
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    env,
    encoding: "utf8",
    shell: isWindows,
  });
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.error) throw res.error;
  return res;
}

function must(cmd, cmdArgs, cwd) {
  const res = run(cmd, cmdArgs, cwd);
  if (res.status !== 0)
    throw new Error(`${cmd} ${cmdArgs.join(" ")} exited ${res.status}`);
  return res;
}

function packages() {
  if (!args.from) return [`@arynbht/rivetari@${args.version}`];
  const dir = resolve(args.from);
  const tarballs = readdirSync(dir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => join(dir, f));
  if (tarballs.length === 0) throw new Error(`no .tgz files in ${dir}`);
  // Every workspace package goes in at once, so the CLI's @arynbht/*
  // dependencies resolve to these tarballs rather than the registry.
  return tarballs;
}

function main() {
  if (!args.from && !process.env.NPM_TOKEN)
    throw new Error(
      "set NPM_TOKEN to a classic personal access token with read:packages",
    );
  // The .npmrc a user writes, word for word; npm reads the token from the env.
  writeFileSync(
    env.npm_config_userconfig,
    "@arynbht:registry=https://npm.pkg.github.com\n" +
      "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n",
  );
  writeFileSync(env.npm_config_globalconfig, "");
  mkdirSync(prefix);
  writeFileSync(join(prefix, "package.json"), '{ "private": true }\n');
  must("npm", ["install", "--no-save", ...packages()], prefix);

  must("rivetari", ["--help"], root);

  mkdirSync(repo);
  must("git", ["init", "--quiet", "--initial-branch=main"], repo);
  must("rivetari", ["init", "--yes", "--type", "web-app"], repo);
  must("rivetari", ["skills", "sync"], repo);

  // doctor exits 1 on any failed check, claude's included; read its lines.
  const doctor = run("rivetari", ["doctor"], repo);
  const status = new Map();
  for (const line of doctor.stdout.split("\n")) {
    const m = /^([✓!✗]) (\S+)/.exec(line);
    if (m) status.set(m[2], m[1]);
  }
  const problems = [
    ...MUST_PASS.filter((name) => status.get(name) !== "✓").map(
      (name) => `${name}: ${status.has(name) ? "not ok" : "missing"}`,
    ),
    ...MUST_NOT_FAIL.filter(
      (name) => !["✓", "!"].includes(status.get(name)),
    ).map((name) => `${name}: ${status.has(name) ? "failed" : "missing"}`),
  ];
  if (problems.length > 0) throw new Error(`doctor: ${problems.join("; ")}`);
}

try {
  main();
  process.stdout.write("\nsmoke test passed\n");
} catch (err) {
  process.stderr.write(`\nsmoke test failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  if (args.keep) process.stdout.write(`kept ${root}\n`);
  else rmSync(root, { recursive: true, force: true });
}
