import { ProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./types";

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  /** Injected so tests do not wait for real time. */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source. Injected so tests are deterministic. */
  random?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  timeoutMs: 30_000,
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with "equal jitter"; honours Retry-After when the provider sends one. */
export function backoffDelay(attempt: number, policy: RetryPolicy, error?: ProviderError): number {
  if (error?.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  const exp = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  const random = policy.random ?? Math.random;
  return Math.round(exp / 2 + (random() * exp) / 2);
}

async function withTimeout(
  provider: LlmProvider,
  request: CompletionRequest,
  timeoutMs: number,
): Promise<CompletionResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError("timeout", `provider did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.complete({ ...request, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ResilientResult extends CompletionResult {
  attempts: number;
}

/** Calls the provider with a per-attempt timeout and retries retryable errors (429, 5xx, timeouts, network). */
export async function completeWithRetry(
  provider: LlmProvider,
  request: CompletionRequest,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<ResilientResult> {
  const sleep = policy.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withTimeout(provider, request, policy.timeoutMs);
      return { ...result, attempts: attempt + 1 };
    } catch (err) {
      const error =
        err instanceof ProviderError
          ? err
          : new ProviderError("network", (err as Error).message, { cause: err });
      if (!error.retryable || attempt >= policy.maxRetries) throw error;
      await sleep(backoffDelay(attempt, policy, error));
    }
  }
}
