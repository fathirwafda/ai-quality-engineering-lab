import { INTENTS, type Intent } from "../schema";

export type ConfusionMatrix = Record<Intent, Record<Intent, number>>;

export function emptyConfusion(): ConfusionMatrix {
  return Object.fromEntries(
    INTENTS.map((a) => [a, Object.fromEntries(INTENTS.map((p) => [p, 0]))]),
  ) as ConfusionMatrix;
}

/** pairs: [expected, predicted]. */
export function confusionMatrix(pairs: Array<[Intent, Intent]>): ConfusionMatrix {
  const m = emptyConfusion();
  for (const [expected, predicted] of pairs) m[expected][predicted]++;
  return m;
}

export interface ClassStats {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
}

export function perClassStats(m: ConfusionMatrix): Record<Intent, ClassStats> {
  return Object.fromEntries(
    INTENTS.map((c) => {
      const tp = m[c][c];
      const predicted = INTENTS.reduce((n, e) => n + m[e][c], 0);
      const support = INTENTS.reduce((n, p) => n + m[c][p], 0);
      const precision = predicted ? tp / predicted : null;
      const recall = support ? tp / support : null;
      const f1 =
        precision !== null && recall !== null && precision + recall > 0
          ? (2 * precision * recall) / (precision + recall)
          : null;
      return [c, { precision, recall, f1, support }];
    }),
  ) as Record<Intent, ClassStats>;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]!;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function rate(passed: number, total: number): number | null {
  return total ? passed / total : null;
}

export function round(n: number | null, digits = 3): number | null {
  return n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
}
