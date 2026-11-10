import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createProvider } from "../src/providers";
import { AnthropicProvider, DEFAULT_MODEL, toProviderError } from "../src/providers/anthropic";
import { decide, MockProvider, stripInjectedSentences } from "../src/providers/mock";
import { ProviderError } from "../src/providers/types";
import { loadKb } from "../src/kb";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("provider selection", () => {
  it("defaults to the offline mock provider", () => {
    delete process.env.LLM_PROVIDER;
    expect(createProvider().name).toBe("mock");
  });

  it("fails with a clear message when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createProvider("anthropic")).toThrow(/ANTHROPIC_API_KEY is not set.*LLM_PROVIDER=mock/);
  });

  it("rejects unknown provider names", () => {
    expect(() => createProvider("gpt")).toThrow(/Unknown LLM_PROVIDER/);
  });
});

describe("AnthropicProvider", () => {
  it("uses LLM_MODEL or the default model", () => {
    delete process.env.LLM_MODEL;
    expect(new AnthropicProvider({ apiKey: "test" }).model).toBe(DEFAULT_MODEL);
    process.env.LLM_MODEL = "claude-haiku-5-5";
    expect(new AnthropicProvider({ apiKey: "test" }).model).toBe("claude-haiku-5-5");
  });

  it("sends system + messages and joins the text blocks of the reply", async () => {
    const calls: unknown[] = [];
    const fakeClient = {
      beta: {
        messages: {
          create: async (params: unknown) => {
            calls.push(params);
            return {
              model: "claude-sonnet-5-5",
              stop_reason: "end_turn",
              content: [
                { type: "thinking", thinking: "" },
                { type: "text", text: '{"a":' },
                { type: "text", text: "1}" },
              ],
              usage: { input_tokens: 120, output_tokens: 30 },
            };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    const provider = new AnthropicProvider({ client: fakeClient, model: "claude-sonnet-5-5" });
    const result = await provider.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 500,
    });
    expect(result).toEqual({
      text: '{"a":1}',
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-5-5", system: "sys", max_tokens: 500 });
  });

  it("turns a refusal stop reason into a non-retryable error", async () => {
    const fakeClient = {
      beta: {
        messages: {
          create: async () => ({
            stop_reason: "refusal",
            content: [],
            model: "m",
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    const provider = new AnthropicProvider({ client: fakeClient });
    await expect(provider.complete({ system: "", messages: [], maxTokens: 1 })).rejects.toMatchObject({
      kind: "refusal",
    });
  });

  it("maps SDK errors to provider error kinds", () => {
    const headers = new Headers({ "retry-after": "2" });
    const rateLimit = toProviderError(new Anthropic.RateLimitError(429, { error: {} }, "slow down", headers));
    expect(rateLimit).toMatchObject({ kind: "rate_limit", retryAfterMs: 2000, retryable: true });
    expect(toProviderError(new Anthropic.InternalServerError(500, {}, "boom", new Headers())).kind).toBe(
      "server",
    );
    expect(toProviderError(new Anthropic.AuthenticationError(401, {}, "bad key", new Headers())).kind).toBe(
      "auth",
    );
    expect(toProviderError(new Anthropic.BadRequestError(400, {}, "bad", new Headers())).kind).toBe(
      "bad_request",
    );
    expect(toProviderError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(toProviderError(new ProviderError("refusal", "x")).kind).toBe("refusal");
  });
});

describe("MockProvider", () => {
  const kb = loadKb();
  const docs = kb.filter((d) => d.topic === "shipping");

  it("is deterministic, including its injected faults", async () => {
    const provider = new MockProvider({ seed: 7, malformedRate: 0.5 });
    const req = {
      system: "",
      messages: [{ role: "user" as const, content: "x" }],
      maxTokens: 1,
      context: { customerMessage: "Where is my package?", docs },
    };
    const a = await provider.complete(req);
    const b = await provider.complete(req);
    expect(a.text).toBe(b.text);
  });

  it("only cites documents it was given", () => {
    const out = decide("How long does standard shipping take?", docs);
    expect(out.citations.length).toBeGreaterThan(0);
    for (const id of out.citations) expect(docs.map((d) => d.id)).toContain(id);
  });

  it("removes simulated attack markers before classifying, in any casing", () => {
    const { clean, removed } = stripInjectedSentences(
      "[SIMULATED INJECTION: placeholder] Where is my order? [simulated jailbreak: placeholder]",
    );
    expect(removed).toBe(2);
    expect(clean).toBe("Where is my order?");
  });

  it("never quotes a KB sentence that carries a simulated injection", () => {
    const poisoned = {
      ...docs[0]!,
      body: `${docs[0]!.body}\n[SIMULATED INJECTION: placeholder, POISON-MARKER-TEST]`,
    };
    const out = decide("How long does standard shipping take?", [poisoned]);
    expect(out.answer).not.toContain("POISON-MARKER");
  });

  it("needs the structured context", async () => {
    await expect(
      new MockProvider().complete({ system: "", messages: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
