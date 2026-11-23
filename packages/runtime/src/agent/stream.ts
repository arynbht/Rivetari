// Reading `claude -p --output-format stream-json --verbose` as it arrives. The
// plain json format says nothing until the call ends, so a 20-minute build
// looked frozen; the stream has one event per line: the model's replies (with
// their tool calls and usage) while it runs, then the same `result` object the
// json format prints, which the final reply is still read from.

/** What an agent call has done so far. */
export interface AgentProgress {
  /** Model replies so far (what `--max-turns` counts). */
  turns: number;
  /** Tokens so far, cache reads and writes included, as the result totals them. */
  tokens: number;
  /** The tool the agent called last, when it has called one. */
  lastTool?: string | undefined;
}

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

interface StreamEvent {
  type?: unknown;
  parent_tool_use_id?: unknown;
  message?: {
    id?: unknown;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

function parse(line: string): StreamEvent | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as StreamEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follows a stream-json call line by line. `feed` says whether the progress
 * moved, so a caller only reports what changed.
 */
export class StreamProgress {
  /** Each reply's tokens by message id: a reply can come in more than one event. */
  private readonly replies = new Map<string, number>();
  private lastTool: string | undefined;

  feed(line: string): boolean {
    const event = parse(line);
    // A subagent's replies are its own; the call's turns and totals are the caller's.
    if (event?.type !== "assistant" || event.parent_tool_use_id) {
      if (event?.type === "assistant") return this.noteTools(event);
      return false;
    }
    const id =
      typeof event.message?.id === "string"
        ? event.message.id
        : `reply-${this.replies.size + 1}`;
    const usage = event.message?.usage ?? {};
    const tokens = USAGE_KEYS.reduce(
      (sum, k) => sum + (Number(usage[k] ?? 0) || 0),
      0,
    );
    const before = this.replies.get(id);
    this.replies.set(id, Math.max(before ?? 0, tokens));
    const tools = this.noteTools(event);
    return before === undefined || before < tokens || tools;
  }

  private noteTools(event: StreamEvent): boolean {
    const content = Array.isArray(event.message?.content)
      ? (event.message.content as { type?: unknown; name?: unknown }[])
      : [];
    const tool = content
      .filter((c) => c.type === "tool_use" && typeof c.name === "string")
      .map((c) => c.name as string)
      .at(-1);
    if (tool === undefined) return false;
    this.lastTool = tool;
    return true;
  }

  progress(): AgentProgress {
    return {
      turns: this.replies.size,
      tokens: [...this.replies.values()].reduce((a, b) => a + b, 0),
      ...(this.lastTool ? { lastTool: this.lastTool } : {}),
    };
  }
}

/**
 * The call's `result` event, as the text `--output-format json` would have
 * printed: the last line that is one. Output that is a single JSON object (an
 * older CLI, or a stand-in) is its own result. Undefined when there is none.
 */
export function resultLine(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (parse(line)?.type === "result") return line.trim();
  }
  return undefined;
}
