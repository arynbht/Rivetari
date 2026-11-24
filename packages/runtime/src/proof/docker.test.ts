// The infra-plan proof's container runner, against a stand-in docker binary:
// it builds, runs and checks the container, fails what doesn't build or
// answer, and with no Docker says it didn't run rather than passing.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dockerProof } from "./docker.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

// Behaves like the docker CLI for the calls the runner makes. A file beside
// it switches behaviour: `down` (no daemon), `noserve` (the container never
// answers). Every call is logged to calls.log.
const FAKE = String.raw`
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const here = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.log"), args.join(" ") + "\n");
const has = (f) => fs.existsSync(path.join(here, f));
switch (args[0]) {
  case "version":
    if (has("down")) { console.error("Cannot connect to the Docker daemon"); process.exit(1); }
    console.log("27.0.0"); break;
  case "build": {
    const file = args[args.indexOf("-f") + 1];
    if (fs.readFileSync(file, "utf8").includes("FAIL")) { console.error("failed to solve: RUN exit 1"); process.exit(1); }
    console.log("built"); break;
  }
  case "run": {
    const host = args[args.indexOf("-p") + 1].split(":")[1];
    if (has("noserve")) { console.log("deadbeef"); break; }
    const child = spawn(process.execPath, ["-e", 'require("http").createServer((q, s) => { s.statusCode = q.url === "/health" ? 200 : 404; s.end("ok"); }).listen(' + host + ', "127.0.0.1")'], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    console.log(String(child.pid)); break;
  }
  case "rm": {
    const id = Number(args[args.length - 1]);
    if (id) { try { process.kill(id); } catch {} }
    break;
  }
  case "logs": console.log("listening on 8080"); break;
  case "rmi": break;
  default: console.error("unknown " + args[0]); process.exit(2);
}
`;

/** A directory holding the stand-in `docker`, and a checkout with a Dockerfile. */
async function fixture(dockerfile = "FROM node:22\n") {
  const bin = await mkdtemp(join(tmpdir(), "rivetari-fake-docker-"));
  const cwd = await mkdtemp(join(tmpdir(), "rivetari-docker-app-"));
  made.push(bin, cwd);
  await writeFile(join(bin, "fake-docker.cjs"), FAKE);
  if (process.platform === "win32") {
    await writeFile(
      join(bin, "docker.cmd"),
      '@node "%~dp0fake-docker.cjs" %*\r\n',
    );
  } else {
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh\nexec node "${join(bin, "fake-docker.cjs")}" "$@"\n`,
    );
    await chmod(join(bin, "docker"), 0o755);
  }
  await writeFile(join(cwd, "Dockerfile"), dockerfile);
  return { docker: join(bin, "docker"), bin, cwd };
}

const calls = async (bin: string) =>
  (await readFile(join(bin, "calls.log"), "utf8")).trim().split("\n");

describe("docker proof", { timeout: 60_000 }, () => {
  it("builds, runs and checks the container answers, then removes it", async () => {
    const f = await fixture();
    const result = await dockerProof({
      cwd: f.cwd,
      config: { port: 8080, path: "/health", timeout: 10 },
      hostPort: 5481,
      tag: "T-0009",
      docker: f.docker,
    });
    expect(result.status).toBe("passed");
    expect(result.line).toMatch(
      /^docker: Dockerfile built and ran; GET \/health on container port 8080 answered 200 after \d+s$/,
    );
    const log = await calls(f.bin);
    expect(log[1]).toMatch(
      /^build -f .*Dockerfile -t rivetari-proof-t-0009:latest /,
    );
    expect(log[2]).toBe(
      "run -d --name rivetari-proof-t-0009 -p 127.0.0.1:5481:8080 rivetari-proof-t-0009:latest",
    );
    expect(log.slice(-2)[0]).toMatch(/^rm -f \d+$/);
    expect(log.slice(-1)[0]).toBe("rmi -f rivetari-proof-t-0009:latest");
  });

  it("with no docker binary, or no daemon, says it didn't run: unverified, not passed", async () => {
    const f = await fixture();
    const missing = await dockerProof({
      cwd: f.cwd,
      config: { port: 8080 },
      hostPort: 5482,
      tag: "T-1",
      docker: join(f.bin, "no-such-docker"),
    });
    expect(missing).toEqual({
      status: "unverified",
      line: "docker: not run: docker unavailable; unverified, a person attaches the infra-plan proof",
    });
    await writeFile(join(f.bin, "down"), "");
    const down = await dockerProof({
      cwd: f.cwd,
      config: { port: 8080 },
      hostPort: 5482,
      tag: "T-1",
      docker: f.docker,
    });
    expect(down.status).toBe("unverified");
    expect(down.line).toMatch(
      /^docker: not run: docker unavailable \(Cannot connect to the Docker daemon\)/,
    );
  });

  it("an image that doesn't build fails the proof, told why", async () => {
    const f = await fixture("FROM node:22\nRUN FAIL\n");
    const result = await dockerProof({
      cwd: f.cwd,
      config: { port: 8080 },
      hostPort: 5483,
      tag: "T-1",
      docker: f.docker,
    });
    expect(result.status).toBe("failed");
    expect(result.line).toMatch(
      /^docker: Dockerfile didn't build \(exit 1\): .*failed to solve/,
    );
  });

  it("a container that never answers fails, with its logs", async () => {
    const f = await fixture();
    await writeFile(join(f.bin, "noserve"), "");
    const result = await dockerProof({
      cwd: f.cwd,
      config: { port: 8080, timeout: 2 },
      hostPort: 5484,
      tag: "T-1",
      docker: f.docker,
    });
    expect(result.status).toBe("failed");
    expect(result.line).toMatch(
      /didn't answer below 400 within 2s \(no answer\); logs: listening on 8080$/,
    );
    expect(await calls(f.bin)).toContain("rm -f deadbeef");
  });

  it("with no port to check on, builds the image and calls serving unverified", async () => {
    const f = await fixture();
    const result = await dockerProof({
      cwd: f.cwd,
      config: {},
      hostPort: 5485,
      tag: "T-1",
      docker: f.docker,
    });
    expect(result.status).toBe("unverified");
    expect(result.line).toMatch(
      /^docker: Dockerfile built; not run: no proof\.docker\.port/,
    );
    expect((await calls(f.bin)).some((c) => c.startsWith("run"))).toBe(false);
  });
});
