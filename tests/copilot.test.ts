import { describe, expect, it } from "vitest";
import { SupportCopilot } from "../src/copilot";
import { MockProvider } from "../src/providers/mock";
import { ProviderError } from "../src/providers/types";
import type { RetryPolicy } from "../src/providers/resilience";
import { SAFE_FALLBACK } from "../src/schema";
import { ScriptedProvider, validReply } from "./helpers/scripted-provider";

const fastRetry: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  timeoutMs: 1000,
  sleep: async () => {},
};
const question = "How long does standard shipping take?";

describe("SupportCopilot pipeline", () => {
  it("returns a valid answer on the first try", async () => {
    const provider = new ScriptedProvider([validReply()]);
    const { output, trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(output.intent).toBe("shipping");
    expect(trace).toMatchObject({
      firstPassValid: true,
      repaired: false,
      schemaValid: true,
      providerCalls: 1,
    });
    expect(trace.retrieved[0]?.id).toBe("shipping-options");
  });

  it("repairs malformed JSON with one extra call that includes the errors", async () => {
    const provider = new ScriptedProvider(['Sure! {"intent": "shipping", "answer": ', validReply()]);
    const { output, trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(output.intent).toBe("shipping");
    expect(trace).toMatchObject({
      firstPassValid: false,
      repaired: true,
      schemaValid: true,
      providerCalls: 2,
    });
    const repairTurn = provider.requests[1]!.messages.at(-1)!.content;
    expect(repairTurn).toMatch(/invalid JSON/);
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("repairs a reply that cites a document that was not retrieved", async () => {
    const provider = new ScriptedProvider([validReply({ citations: ["secret-doc"] }), validReply()]);
    const { trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(trace.validationErrors[0]).toMatch(/secret-doc/);
    expect(trace.schemaValid).toBe(true);
  });

  it("falls back to a safe escalation when the repair also fails", async () => {
    const provider = new ScriptedProvider(["nope", "still nope"]);
    const { output, trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(output).toEqual(SAFE_FALLBACK);
    expect(trace).toMatchObject({ schemaValid: false, repaired: true });
  });

  it("falls back safely when the provider keeps failing", async () => {
    const provider = new ScriptedProvider([
      new ProviderError("rate_limit", "429"),
      new ProviderError("rate_limit", "429"),
      new ProviderError("rate_limit", "429"),
    ]);
    const { output, trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(output).toEqual(SAFE_FALLBACK);
    expect(trace.providerError).toMatch(/^rate_limit/);
  });

  it("redacts PII before the prompt is sent", async () => {
    const provider = new ScriptedProvider([validReply({ intent: "billing", citations: [] })]);
    await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(
      "My card 4111 1111 1111 1111 was charged twice, mail me at sam@example.com",
    );
    const sent = provider.requests[0]!.messages[0]!.content;
    expect(sent).not.toContain("4111");
    expect(sent).not.toContain("sam@example.com");
    expect(sent).toContain("[REDACTED_CARD]");
  });

  it("output guard removes PII the model wrote anyway", async () => {
    const provider = new ScriptedProvider([
      validReply({ answer: "Write to orders-team@example.com for help." }),
    ]);
    const { output, trace } = await new SupportCopilot({ provider, retryPolicy: fastRetry }).answer(question);
    expect(output.answer).toBe("Write to [REDACTED_EMAIL] for help.");
    expect(trace.outputGuardTriggered).toBe(true);
  });

  it("recovers from the mock provider's injected malformed replies", async () => {
    const copilot = new SupportCopilot({
      provider: new MockProvider({ malformedRate: 1 }),
      retryPolicy: fastRetry,
    });
    const { trace } = await copilot.answer(question);
    expect(trace).toMatchObject({ firstPassValid: false, repaired: true, schemaValid: true });
  });
});
