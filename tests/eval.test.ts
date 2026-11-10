import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../eval.config";
import { CATEGORIES, loadGolden, parseGoldenLines } from "../src/eval/dataset";
import { evaluateGates } from "../src/eval/gate";
import { lexicalGroundedness } from "../src/eval/groundedness";
import { TRANSFORMS, typo } from "../src/eval/metamorphic";
import { confusionMatrix, percentile, perClassStats } from "../src/eval/metrics";
import { estimateCostUsd } from "../src/eval/pricing";
import { loadKb } from "../src/kb";

describe("golden dataset", () => {
  const cases = loadGolden();

  it("has at least 40 valid cases covering every category", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.category))).toEqual(new Set(CATEGORIES));
  });

  it("only references KB documents that exist", () => {
    const known = new Set([...loadKb().map((d) => d.id), ...cases.flatMap((c) => c.kbOverlay ?? [])]);
    for (const c of cases)
      for (const id of c.expected.relevantDocs) expect(known, `${c.id} -> ${id}`).toContain(id);
  });

  it("loads local red-team files only when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const line = (id: string) =>
      JSON.stringify({
        id,
        category: "injection",
        message: "placeholder",
        expected: { intent: "other", relevantDocs: [], escalate: false },
      });
    writeFileSync(join(dir, "committed.jsonl"), line("com-001"));
    writeFileSync(join(dir, "local-adversarial.jsonl"), line("loc-001"));
    expect(loadGolden(dir).map((c) => c.id)).toEqual(["com-001"]);
    expect(loadGolden(dir, { includeLocal: true }).map((c) => c.id)).toEqual(["com-001", "loc-001"]);
  });

  it("ships placeholders instead of real attack text", () => {
    const attacks = cases.filter((c) => ["injection", "jailbreak"].includes(c.category) && !c.kbOverlay);
    for (const c of attacks) expect(c.message, c.id).toMatch(/\[SIMULATED (INJECTION|JAILBREAK): /);
  });

  it("gives a useful error for a broken line", () => {
    expect(() => parseGoldenLines('{"id":"x"}', "bad.jsonl")).toThrow(/bad.jsonl:1/);
  });

  it("has a consistency set made of real case ids", () => {
    const ids = new Set(cases.map((c) => c.id));
    for (const id of config.consistencyCaseIds) expect(ids).toContain(id);
  });
});

describe("metrics", () => {
  it("builds a confusion matrix and per-class precision/recall", () => {
    const m = confusionMatrix([
      ["billing", "billing"],
      ["billing", "returns"],
      ["returns", "returns"],
    ]);
    const stats = perClassStats(m);
    expect(stats.billing).toMatchObject({ precision: 1, recall: 0.5, support: 2 });
    expect(stats.returns).toMatchObject({ precision: 0.5, recall: 1 });
    expect(stats.account.precision).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });

  it("estimates cost for known models only", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", 1_000_000, 100_000)).toBeCloseTo(3);
    expect(estimateCostUsd("mock-rules-v1", 10, 10)).toBeNull();
  });
});

describe("lexical groundedness", () => {
  const doc = loadKb().find((d) => d.id === "refunds-timeline")!;

  it("supports sentences taken from the cited document", () => {
    expect(
      lexicalGroundedness("Inspecting a return takes up to 3 business days after it arrives.", [doc]).score,
    ).toBe(1);
  });

  it("flags an invented policy", () => {
    const r = lexicalGroundedness("We give every customer a free gift voucher worth fifty dollars.", [doc]);
    expect(r.score).toBe(0);
    expect(r.unsupported).toHaveLength(1);
  });

  it("ignores hand-off sentences that carry no claim", () => {
    expect(
      lexicalGroundedness("I have passed this to a member of our support team.", [doc]).score,
    ).toBeNull();
  });
});

describe("metamorphic transforms", () => {
  it("are deterministic and actually change the text", () => {
    const message = "How long does standard shipping take?";
    for (const t of TRANSFORMS) expect(t.apply(message), t.name).not.toBe(message);
    expect(typo(message)).toBe(typo(message));
  });
});

describe("quality gate", () => {
  const passing = Object.fromEntries(config.gates.map((g) => [g.metric, g.op === "min" ? 1 : 0]));

  it("passes when every metric meets its threshold", () => {
    expect(evaluateGates(passing, config).passed).toBe(true);
  });

  it("fails when a threshold is missed", () => {
    const report = evaluateGates({ ...passing, injectionPassRate: 0.9 }, config);
    expect(report.passed).toBe(false);
    expect(report.gates.find((g) => g.metric === "injectionPassRate")?.passed).toBe(false);
  });

  it("fails when a metric is missing (null)", () => {
    expect(evaluateGates({ ...passing, groundedness: null }, config).passed).toBe(false);
  });

  it("fails on a regression versus baseline even when the absolute gate passes", () => {
    const baseline = {
      provider: "mock",
      model: "m",
      updatedAt: "x",
      metrics: { ...passing, intentAccuracy: 0.99 },
    };
    const report = evaluateGates({ ...passing, intentAccuracy: 0.95 }, config, baseline);
    expect(report.deltas.find((d) => d.metric === "intentAccuracy")).toMatchObject({
      delta: -0.04,
      regressed: true,
    });
    expect(report.passed).toBe(false);
  });
});
