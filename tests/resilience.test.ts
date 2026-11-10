import { describe, expect, it, vi } from "vitest";
import { backoffDelay, completeWithRetry, type RetryPolicy } from "../src/providers/resilience";
import { ProviderError, type LlmProvider } from "../src/providers/types";
import { ScriptedProvider } from "./helpers/scripted-provider";

const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    timeoutMs: 50,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
    ...overrides,
  };
}

describe("retry and backoff", () => {
  it("retries 429 with exponential backoff and then succeeds", async () => {
    const p = policy();
    const provider = new ScriptedProvider([
      new ProviderError("rate_limit", "429"),
      new ProviderError("rate_limit", "429"),
      "ok",
    ]);
    const result = await completeWithRetry(provider, request, p);
    expect(result.text).toBe("ok");
    expect(result.attempts).toBe(3);
    // equal jitter with random=0.5: 0.75 * base * 2^attempt
    expect(p.sleeps).toEqual([75, 150]);
  });

  it("honours Retry-After when the provider sends it", async () => {
    const p = policy();
    const provider = new ScriptedProvider([
      new ProviderError("rate_limit", "429", { retryAfterMs: 700 }),
      "ok",
    ]);
    await completeWithRetry(provider, request, p);
    expect(p.sleeps).toEqual([700]);
  });

  it("caps the delay at maxDelayMs", () => {
    expect(backoffDelay(10, policy({ random: () => 1 }))).toBe(1000);
    expect(backoffDelay(0, policy(), new ProviderError("rate_limit", "x", { retryAfterMs: 60_000 }))).toBe(
      1000,
    );
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const p = policy({ maxRetries: 2 });
    const provider = new ScriptedProvider([
      new ProviderError("server", "500"),
      new ProviderError("server", "502"),
      new ProviderError("server", "503"),
    ]);
    await expect(completeWithRetry(provider, request, p)).rejects.toMatchObject({
      kind: "server",
      message: "503",
    });
    expect(provider.requests).toHaveLength(3);
  });

  it.each(["auth", "bad_request", "refusal"] as const)("does not retry %s errors", async (kind) => {
    const provider = new ScriptedProvider([new ProviderError(kind, kind), "never reached"]);
    await expect(completeWithRetry(provider, request, policy())).rejects.toMatchObject({ kind });
    expect(provider.requests).toHaveLength(1);
  });

  it("times out a hanging call, aborts it, and retries", async () => {
    let aborted = false;
    const provider = new ScriptedProvider([
      (req) =>
        new Promise<string>((_, reject) => {
          req.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      "ok",
    ]);
    const result = await completeWithRetry(provider, request, policy({ timeoutMs: 20 }));
    expect(aborted).toBe(true);
    expect(result).toMatchObject({ text: "ok", attempts: 2 });
  });

  it("raises a timeout ProviderError when every attempt hangs", async () => {
    vi.useFakeTimers();
    const hanging: LlmProvider = { name: "hang", model: "m", complete: () => new Promise(() => {}) };
    const promise = completeWithRetry(hanging, request, policy({ maxRetries: 0, timeoutMs: 5000 }));
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });

  it("wraps unknown errors as retryable network errors", async () => {
    const provider = new ScriptedProvider([new TypeError("fetch failed"), "ok"]);
    expect((await completeWithRetry(provider, request, policy())).attempts).toBe(2);
  });
});
