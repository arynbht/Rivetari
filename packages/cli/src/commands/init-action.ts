// The rivetari.yml workflow `rivetari init` writes, and the commit it pins the
// Rivetari action to. A tag can be moved to code nobody reviewed, and this
// workflow runs with the repo's token, so the action is pinned by commit SHA
// with the release's tag beside it as a comment, never by a moving tag.
import { readFile } from "node:fs/promises";

export const ACTION_REPO = "arynbht/rivetari";
const ACTION = `${ACTION_REPO}/packages/action`;
const CHECKOUT =
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0";

export interface ActionPin {
  sha: string;
  /** The release tag the SHA is, or how it was chosen; written as a comment. */
  tag: string;
}

/** What an unpinned rivetari.yml says, and how init recognises one it wrote. */
const UNPINNED = "rivetari init could not pin the Rivetari action to a commit";

/**
 * `--action-ref`: a 40-hex commit SHA, or `<sha>:<tag>` to name the release in
 * the comment. Null when it isn't one.
 */
export function parseActionRef(ref: string): ActionPin | null {
  const at = ref.indexOf(":");
  const sha = (at < 0 ? ref : ref.slice(0, at)).trim().toLowerCase();
  const tag = at < 0 ? "" : ref.slice(at + 1).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return { sha, tag: tag || "pinned with --action-ref" };
}

export interface ResolvePinOptions {
  token?: string | undefined;
  /** The CLI's version; read from its package.json by default. */
  version?: string;
  fetch?: typeof fetch;
}

async function cliVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof pkg.version !== "string")
    throw new Error("the CLI's package.json has no version");
  return pkg.version;
}

interface GitObject {
  object?: { type?: string; sha?: string };
}

/**
 * The commit of the release this CLI belongs to (tag `v<version>`), or of the
 * latest release when there's no such tag, read from the GitHub API. Throws
 * with the reason when neither can be read.
 */
export async function resolveReleasePin(
  options: ResolvePinOptions = {},
): Promise<ActionPin> {
  const get = options.fetch ?? fetch;
  const api = async <T>(path: string): Promise<T | null> => {
    const res = await get(
      `https://api.github.com/repos/${ACTION_REPO}${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "rivetari-cli",
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  // A lightweight tag points at the commit; an annotated one at a tag object
  // that points at it.
  const commitOf = async (tag: string): Promise<string | null> => {
    let ref = await api<GitObject>(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref?.object?.type === "tag")
      ref = await api<GitObject>(`/git/tags/${ref.object.sha}`);
    const sha = ref?.object?.type === "commit" ? ref.object.sha : undefined;
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };
  const own = `v${options.version ?? (await cliVersion())}`;
  const sha = await commitOf(own);
  if (sha) return { sha, tag: own };
  const latest = await api<{ tag_name?: string }>("/releases/latest");
  if (latest?.tag_name) {
    const latestSha = await commitOf(latest.tag_name);
    if (latestSha) return { sha: latestSha, tag: latest.tag_name };
  }
  throw new Error(`${ACTION_REPO} has no tag ${own} and no latest release`);
}

/** Whether `text` is a rivetari.yml init wrote without a pinned action. */
export const isUnpinnedWorkflow = (text: string): boolean =>
  text.includes(UNPINNED);

function actionStep(phase: string, pin: ActionPin | null): string {
  const inputs = `        with:
          gate: ${phase}
          token: \${{ secrets.GITHUB_TOKEN }}`;
  if (pin) return `      - uses: ${ACTION}@${pin.sha} # ${pin.tag}\n${inputs}`;
  return `      # ${UNPINNED}.
      # Replace this step with the action at a release's commit SHA
      # (https://github.com/${ACTION_REPO}/releases):
      #   - uses: ${ACTION}@<40-hex sha> # <tag>
${inputs.replace(/^ {6}/gm, "      #   ")}
      # or run \`rivetari init --force --action-ref <sha>\` again.
      - name: Rivetari action not pinned
        run: |
          echo "::error::${UNPINNED}. Pin it in .github/workflows/rivetari.yml, or run rivetari init --force --action-ref <sha>."
          exit 1`;
}

/** The rivetari.yml workflow written into the target repo. */
export function renderRivetariWorkflow(
  phase: string,
  pin: ActionPin | null,
): string {
  const step = actionStep(phase, pin);
  return `name: rivetari
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 6 * * 1" # Mondays 06:17 UTC
  workflow_dispatch:

# Least privilege by default; each job widens only what it needs.
permissions:
  contents: read

# One run per ref so a newer push/PR update supersedes an in-flight run and the two
# can't race on the sticky comment or the status issue.
concurrency:
  group: rivetari-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  # PR runs post a sticky review comment — pull-requests:write only.
  audit-pr:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: ${CHECKOUT}
${step}

  # Scheduled / push / manual runs maintain the pinned status issue — issues:write only.
  audit-status:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - uses: ${CHECKOUT}
${step}
`;
}
