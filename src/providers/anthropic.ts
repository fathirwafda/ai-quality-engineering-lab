import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./types";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  /** Injected in tests. */
  client?: Pick<Anthropic, "beta">;
}

function retryAfterMs(headers: unknown): number | undefined {
  let value: string | null | undefined;
  if (headers && typeof (headers as Headers).get === "function")
    value = (headers as Headers).get("retry-after");
  else if (headers && typeof headers === "object") value = (headers as Record<string, string>)["retry-after"];
  const seconds = value ? Number(value) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Maps SDK errors to our provider-neutral error kinds (most specific first). */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError)
    return new ProviderError("timeout", "request aborted", { cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError("timeout", err.message, { cause: err });
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError("network", err.message, { cause: err });
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("rate_limit", err.message, {
      cause: err,
      retryAfterMs: retryAfterMs(err.headers),
    });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("auth", err.message, { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
    return new ProviderError("bad_request", err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 429) return new ProviderError("rate_limit", err.message, { cause: err });
    if (status >= 500 || status === 408 || status === 409)
      return new ProviderError("server", err.message, { cause: err });
    return new ProviderError("bad_request", err.message, { cause: err });
  }
  return new ProviderError("network", (err as Error)?.message ?? String(err), { cause: err });
}

/**
 * Calls Claude through the official SDK (Messages API).
 * SDK-level retries are disabled (maxRetries: 0) so that retry, backoff and timeout behaviour lives in
 * one place (resilience.ts) where the tests can see it.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Pick<Anthropic, "beta">;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    if (options.client) {
      this.client = options.client;
      return;
    }
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "auth",
        "ANTHROPIC_API_KEY is not set. Export it (see the README Configuration section) or run with LLM_PROVIDER=mock for the offline provider.",
      );
    }
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let response;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          // Classification-style task: low effort keeps latency and cost down.
          output_config: { effort: "low" },
          // If a safety classifier declines, the API re-runs the request on a fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      throw toProviderError(err);
    }
    if (response.stop_reason === "refusal") {
      throw new ProviderError("refusal", "the model declined to answer this request");
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
