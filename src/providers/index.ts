import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import type { LlmProvider } from "./types";

export * from "./types";
export { AnthropicProvider } from "./anthropic";
export { MockProvider } from "./mock";

/** Picks the provider from LLM_PROVIDER. Mock is the default so nothing needs a key unless you ask for it. */
export function createProvider(name: string = process.env.LLM_PROVIDER ?? "mock"): LlmProvider {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "anthropic":
      return new AnthropicProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}". Use "mock" or "anthropic".`);
  }
}
