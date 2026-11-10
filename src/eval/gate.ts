import type { EvalConfig, Gate } from "../../eval.config";
import type { Metrics } from "./runner";

export interface GateResult extends Gate {
  actual: number | null;
  passed: boolean;
}

export interface BaselineDelta {
  metric: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  /** Only "min" gated metrics can regress. */
  regressed: boolean;
}

export interface GateReport {
  gates: GateResult[];
  deltas: BaselineDelta[];
  passed: boolean;
}

export interface Baseline {
  provider: string;
  model: string;
  updatedAt: string;
  metrics: Metrics;
}

export function evaluateGates(metrics: Metrics, config: EvalConfig, baseline?: Baseline | null): GateReport {
  const gates: GateResult[] = config.gates.map((g) => {
    const actual = metrics[g.metric] ?? null;
    const passed = actual !== null && (g.op === "min" ? actual >= g.value : actual <= g.value);
    return { ...g, actual, passed };
  });

  const minMetrics = new Set(config.gates.filter((g) => g.op === "min").map((g) => g.metric));
  const deltas: BaselineDelta[] = baseline
    ? Object.keys(metrics)
        .filter((m) => m in baseline.metrics)
        .map((metric) => {
          const before = baseline.metrics[metric] ?? null;
          const now = metrics[metric] ?? null;
          const delta = before !== null && now !== null ? Math.round((now - before) * 1000) / 1000 : null;
          return {
            metric,
            baseline: before,
            current: now,
            delta,
            regressed: minMetrics.has(metric) && delta !== null && delta < -config.maxRegression,
          };
        })
    : [];

  return { gates, deltas, passed: gates.every((g) => g.passed) && !deltas.some((d) => d.regressed) };
}
