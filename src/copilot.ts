import { loadKb, type KbDoc } from "./kb";
import { detectPii, redactPii } from "./pii";
import { buildRepairPrompt, buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { completeWithRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./providers/resilience";
import { ProviderError, type ChatTurn, type LlmProvider, type TokenUsage } from "./providers/types";
import { Bm25Retriever, type RetrievedDoc } from "./retrieval";
import { SAFE_FALLBACK, validateOutput, type CopilotOutput } from "./schema";

export interface CopilotOptions {
  provider: LlmProvider;
  docs?: KbDoc[];
  topK?: number;
  retryPolicy?: RetryPolicy;
  maxTokens?: number;
}

export interface CopilotTrace {
  retrieved: Array<{ id: string; score: number }>;
  /** Provider calls made, including retries and the repair call. */
  providerCalls: number;
  repaired: boolean;
  /** True when the first reply already passed validation. */
  firstPassValid: boolean;
  /** True when the final output came from the model (possibly after repair), false when we used SAFE_FALLBACK. */
  schemaValid: boolean;
  validationErrors: string[];
  inputPiiRedacted: number;
  /** The model's answer contained PII and the output guard removed it. */
  outputGuardTriggered: boolean;
  providerError?: string;
  latencyMs: number;
  usage: TokenUsage;
  model: string;
}

export interface CopilotResponse {
  output: CopilotOutput;
  trace: CopilotTrace;
}

export class SupportCopilot {
  private readonly provider: LlmProvider;
  private readonly retriever: Bm25Retriever;
  private readonly topK: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxTokens: number;

  constructor(options: CopilotOptions) {
    this.provider = options.provider;
    this.retriever = new Bm25Retriever(options.docs ?? loadKb());
    this.topK = options.topK ?? 3;
    this.retryPolicy = options.retryPolicy ?? {
      ...DEFAULT_RETRY_POLICY,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_RETRY_POLICY.timeoutMs),
    };
    this.maxTokens = options.maxTokens ?? 4000;
  }

  retrieve(message: string): RetrievedDoc[] {
    return this.retriever.search(message, this.topK);
  }

  async answer(customerMessage: string): Promise<CopilotResponse> {
    const started = performance.now();
    // 1. Redact PII before it reaches the prompt (and the provider's logs).
    const { text: message, found } = redactPii(customerMessage);
    // 2. Deterministic retrieval.
    const retrieved = this.retrieve(message);
    const docs = retrieved.map((r) => r.doc);
    const allowed = docs.map((d) => d.id);

    const trace: CopilotTrace = {
      retrieved: retrieved.map((r) => ({ id: r.doc.id, score: r.score })),
      providerCalls: 0,
      repaired: false,
      firstPassValid: false,
      schemaValid: false,
      validationErrors: [],
      inputPiiRedacted: found.length,
      outputGuardTriggered: false,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.provider.model,
    };

    const messages: ChatTurn[] = [{ role: "user", content: buildUserPrompt(message, docs) }];
    const call = async () => {
      const result = await completeWithRetry(
        this.provider,
        {
          system: SYSTEM_PROMPT,
          messages,
          maxTokens: this.maxTokens,
          context: { customerMessage: message, docs },
        },
        this.retryPolicy,
      );
      trace.providerCalls += result.attempts;
      trace.usage.inputTokens += result.usage.inputTokens;
      trace.usage.outputTokens += result.usage.outputTokens;
      trace.model = result.model;
      return result.text;
    };

    let output: CopilotOutput = SAFE_FALLBACK;
    try {
      // 3. First attempt.
      const first = await call();
      let validation = validateOutput(first, allowed);
      trace.firstPassValid = validation.ok;
      // 4. One repair attempt with the validation errors fed back.
      if (!validation.ok) {
        trace.validationErrors.push(...validation.errors);
        messages.push(
          { role: "assistant", content: first },
          { role: "user", content: buildRepairPrompt(validation.errors) },
        );
        const second = await call();
        trace.repaired = true;
        validation = validateOutput(second, allowed);
        if (!validation.ok) trace.validationErrors.push(...validation.errors);
      }
      if (validation.ok && validation.value) {
        output = validation.value;
        trace.schemaValid = true;
      }
    } catch (err) {
      trace.providerError = err instanceof ProviderError ? `${err.kind}: ${err.message}` : String(err);
    }

    // 5. Output guard: never send PII back, whatever the model wrote.
    if (detectPii(output.answer).length > 0) {
      output = { ...output, answer: redactPii(output.answer).text };
      trace.outputGuardTriggered = true;
    }
    trace.latencyMs = Math.round((performance.now() - started) * 100) / 100;
    return { output, trace };
  }
}
