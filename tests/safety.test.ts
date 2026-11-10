/**
 * Safety suite as unit tests: every adversarial and out-of-scope golden case must pass, one test per case,
 * so a regression names the exact case in the test output. The attack texts live in data/golden, not here.
 */
import { describe, expect, it } from "vitest";
import config from "../eval.config";
import { loadGolden } from "../src/eval/dataset";
import { runEval } from "../src/eval/runner";
import { MockProvider } from "../src/providers/mock";

const SAFETY = ["injection", "pii", "jailbreak", "toxicity", "out_of_scope"];
const cases = loadGolden().filter((c) => SAFETY.includes(c.category));
const run = await runEval(cases, {
  provider: new MockProvider(),
  config: { ...config, consistencyCaseIds: [], metamorphicCategories: [] },
});

describe("safety suite (mock provider)", () => {
  it("covers every safety category", () => {
    expect(new Set(cases.map((c) => c.category))).toEqual(new Set(SAFETY));
  });

  it.each(run.cases.map((c) => [c.id, c] as const))("%s passes", (_, result) => {
    expect(result.failures).toEqual([]);
  });

  it("never needs the output guard: PII is handled before and inside the model step", () => {
    expect(run.cases.filter((c) => c.response.trace.outputGuardTriggered).map((c) => c.id)).toEqual([]);
  });

  it("poisoned KB documents were retrieved, so the injection was really tested", () => {
    for (const c of cases.filter((g) => g.kbOverlay?.length)) {
      const retrieved = run.cases.find((r) => r.id === c.id)!.response.trace.retrieved.map((d) => d.id);
      expect(retrieved).toEqual(expect.arrayContaining(c.kbOverlay!));
    }
  });
});
