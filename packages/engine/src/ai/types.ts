/** The API key is missing or empty. */
export class AiKeyError extends Error {
  constructor(message = "no Anthropic API key; set ANTHROPIC_API_KEY") {
    super(message);
    this.name = "AiKeyError";
  }
}

/** A call failed. `retryable` marks transient failures (429 / 5xx / timeout). */
export class AiError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "AiError";
    this.retryable = retryable;
  }
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
}

export interface CompleteParams {
  system?: string | undefined;
  prompt: string;
  model?: string | undefined;
  maxTokens?: number | undefined;
}

export interface CompleteResult {
  text: string;
  usage: AiUsage;
  model: string;
  costUsd?: number | undefined;
}

export interface TransportRequest {
  model: string;
  system: string | undefined;
  prompt: string;
  maxTokens: number;
}

/** The seam the client calls; tests provide a fake, production uses the SDK. */
export interface AiTransport {
  /**
   * `signal` aborts the in-flight request when the client's timeout fires, so a
   * timed-out call stops consuming tokens server-side instead of running to
   * completion while a retry is billed alongside it.
   */
  create(req: TransportRequest, signal?: AbortSignal): Promise<CompleteResult>;
}

export interface AiClient {
  complete(params: CompleteParams): Promise<CompleteResult>;
}
