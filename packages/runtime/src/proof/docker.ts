// The infra-plan proof's runner for the common case, a container: build the
// image, run it, and check it answers over HTTP. A machine without Docker
// can't produce that proof, so it says so and counts it unverified; it never
// stands in a pass for a check that didn't run.
import { join } from "node:path";

import {
  allowlistedEnv,
  runTool,
  ToolNotFoundError,
} from "@arynbht/rivetari-engine";

export interface DockerConfig {
  file?: string | undefined;
  context?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  timeout?: number | undefined;
}

export interface DockerResult {
  status: "passed" | "failed" | "unverified";
  /** One line for the ledger, starting "docker: ". */
  line: string;
}

// The docker CLI needs to find its daemon and config; the build itself runs
// in the container and sees none of this.
const DOCKER_ENV = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_BUILDKIT",
];

const tail = (s: string, n = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/**
 * Build `config.file` in the checkout, run it with `config.port` published
 * on `hostPort`, and GET `config.path` until it answers below 400 or the
 * timeout passes. The container and image are removed either way.
 */
export async function dockerProof(options: {
  cwd: string;
  config: DockerConfig;
  hostPort: number;
  /** A name for the image and container, e.g. the task id. */
  tag: string;
  /** The docker binary (tests pass a stand-in). */
  docker?: string | undefined;
}): Promise<DockerResult> {
  const { cwd, config, hostPort } = options;
  const bin = options.docker ?? "docker";
  const env = allowlistedEnv(DOCKER_ENV);
  const docker = (args: string[], timeoutMs = 60_000) =>
    runTool(bin, args, cwd, { env, timeoutMs });
  const file = config.file ?? "Dockerfile";

  // No binary, or no daemon behind it: nothing here can build an image.
  try {
    const version = await docker([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    if (version.exitCode !== 0)
      return {
        status: "unverified",
        line: `docker: not run: docker unavailable (${tail(version.stderr || version.stdout, 200) || `exit ${version.exitCode}`}); unverified, a person attaches the infra-plan proof`,
      };
  } catch (err) {
    return {
      status: "unverified",
      line: `docker: not run: docker unavailable${err instanceof ToolNotFoundError ? "" : ` (${tail((err as Error).message, 200)})`}; unverified, a person attaches the infra-plan proof`,
    };
  }

  const image = `rivetari-proof-${options.tag.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}:latest`;
  const built = await docker(
    [
      "build",
      "-f",
      join(cwd, file),
      "-t",
      image,
      join(cwd, config.context ?? "."),
    ],
    900_000,
  ).catch((err: Error) => ({ exitCode: -1, stdout: "", stderr: err.message }));
  if (built.exitCode !== 0)
    return {
      status: "failed",
      line: `docker: ${file} didn't build (exit ${built.exitCode}): ${tail(`${built.stdout}\n${built.stderr}`)}`,
    };

  try {
    if (config.port === undefined)
      return {
        status: "unverified",
        line: `docker: ${file} built; not run: no proof.docker.port in .rivetari/profile.yml to check it on, so whether it serves is unverified`,
      };
    const path = config.path ?? "/";
    // Named, so a run that creates the container and then fails (a port
    // already bound, say) can still be removed.
    const name = image.replace(/:latest$/, "");
    const run = await docker([
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${hostPort}:${config.port}`,
      image,
    ]);
    const id = run.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (run.exitCode !== 0 || !id) {
      await docker(["rm", "-f", name]).catch(() => null);
      return {
        status: "failed",
        line: `docker: ${file} built but didn't start (exit ${run.exitCode}): ${tail(`${run.stdout}\n${run.stderr}`)}`,
      };
    }
    try {
      const url = `http://127.0.0.1:${hostPort}${path}`;
      const timeoutMs = (config.timeout ?? 60) * 1000;
      const started = Date.now();
      let last = "no answer";
      while (Date.now() - started < timeoutMs) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          if (res.status < 400)
            return {
              status: "passed",
              line: `docker: ${file} built and ran; GET ${path} on container port ${config.port} answered ${res.status} after ${Math.round((Date.now() - started) / 1000)}s`,
            };
          last = `HTTP ${res.status}`;
        } catch {
          // Not up yet: try again until the timeout.
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const logs = await docker(["logs", "--tail", "40", id]).catch(
        (err: Error) => ({ exitCode: -1, stdout: "", stderr: err.message }),
      );
      return {
        status: "failed",
        line: `docker: ${file} built and ran, but GET ${path} on container port ${config.port} didn't answer below 400 within ${timeoutMs / 1000}s (${last}); logs: ${tail(`${logs.stdout}\n${logs.stderr}`, 300) || "none"}`,
      };
    } finally {
      await docker(["rm", "-f", id]).catch(() => null);
    }
  } finally {
    await docker(["rmi", "-f", image]).catch(() => null);
  }
}

/** A path that's a Dockerfile or compose file: a container change. */
export const isContainerFile = (path: string): boolean =>
  /(^|\/)(Dockerfile(\.[^/]*)?|[^/]*\.dockerfile|\.dockerignore|(docker-)?compose(\.[^/]*)?\.ya?ml)$/i.test(
    path,
  );
