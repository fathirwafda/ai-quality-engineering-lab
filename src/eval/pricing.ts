/**
 * PLACEHOLDER ESTIMATES, NOT OFFICIAL PRICES.
 *
 * USD per million tokens, entered on 2026-11-10 only so the report can show a rough cost figure.
 * They are not checked against a price list and may be wrong or out of date.
 * Official prices: https://www.anthropic.com/pricing (check before you budget with these numbers).
 * Every cost this module produces is labelled "estimated cost (placeholder prices)" in reports.
 */
export const COST_LABEL = "estimated cost (placeholder prices)";

export const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICING_PER_MTOK[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
