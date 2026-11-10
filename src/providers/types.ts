import type { KbDoc } from "../kb";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
  signal?: AbortSignal;
  /**
   * The same inputs that are rendered into the prompt, in structured form.
   * Real providers ignore this; the MockProvider reads it instead of parsing the prompt text.
   */
  context?: { customerMessage: string; docs: KbDoc[] };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: "mock" | "anthropic" | (string & {});
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type ProviderErrorKind =
  "rate_limit" | "timeout" | "server" | "network" | "auth" | "bad_request" | "refusal";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "timeout" ||
      this.kind === "server" ||
      this.kind === "network"
    );
  }
}
