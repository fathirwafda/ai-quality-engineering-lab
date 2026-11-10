import type { CompletionRequest, CompletionResult, LlmProvider } from "../../src/providers/types";

type Step = string | Error | ((request: CompletionRequest) => Promise<string> | string);

/** A provider that replays a script: each call takes the next step (a reply, an error to throw, or a function). */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-model";
  readonly requests: CompletionRequest[] = [];
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("ScriptedProvider ran out of steps");
    if (step instanceof Error) throw step;
    const text = typeof step === "function" ? await step(request) : step;
    return { text, model: this.model, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

export const validReply = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    intent: "shipping",
    answer: "Standard shipping takes 3 to 5 business days and costs $4.95.",
    citations: ["shipping-options"],
    escalate: false,
    confidence: 0.9,
    ...overrides,
  });
