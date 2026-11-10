/**
 * Offline eval + regression gate.
 *   npm run eval                      mock provider (default), compares with baseline.json
 *   LLM_PROVIDER=anthropic npm run eval   real model (needs ANTHROPIC_API_KEY)
 *   npm run eval:update-baseline      writes the current metrics to baseline.json
 * Exit code: 0 = all gates pass, 1 = a gate or the baseline comparison failed, 2 = setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../eval.config";
import { loadGolden } from "../src/eval/dataset";
import { evaluateGates, type Baseline } from "../src/eval/gate";
import { renderHtml, renderMarkdown } from "../src/eval/report";
import { runEval } from "../src/eval/runner";
import { createProvider } from "../src/providers";

const BASELINE_PATH = join(process.cwd(), "baseline.json");
const REPORT_DIR = join(process.cwd(), "reports");
const updateBaseline = process.argv.includes("--update-baseline");

async function main(): Promise<number> {
  let provider;
  try {
    provider = createProvider();
  } catch (err) {
    console.error(`Setup error: ${(err as Error).message}`);
    return 2;
  }
  const judge = provider.name !== "mock" && process.env.EVAL_JUDGE === "1" ? provider : undefined;
  const includeLocal = process.env.EVAL_LOCAL_CASES === "1";
  const cases = loadGolden(undefined, { includeLocal });
  if (includeLocal) console.log("EVAL_LOCAL_CASES=1: local-*.jsonl files in data/golden are included.");
  console.log(
    `Running ${cases.length} golden cases with ${provider.name} (${provider.model})${judge ? " + LLM judge" : ""}...`,
  );

  const run = await runEval(cases, {
    provider,
    config,
    ...(judge ? { judge } : {}),
    onProgress: (done, total) => {
      if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${total} copilot calls`);
    },
  });
  if (process.stdout.isTTY) process.stdout.write("\n");

  const stored: Baseline | null = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : null;
  const comparable = stored && stored.provider === run.provider && stored.model === run.model ? stored : null;
  const note =
    stored && !comparable
      ? `baseline.json was recorded with ${stored.provider}/${stored.model}; regression comparison skipped for ${run.provider}/${run.model}.`
      : undefined;
  const gate = evaluateGates(run.metrics, config, comparable);

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "eval-report.json"), JSON.stringify({ ...run, gate }, null, 2));
  writeFileSync(join(REPORT_DIR, "eval-report.md"), renderMarkdown(run, gate, note));
  writeFileSync(join(REPORT_DIR, "eval-report.html"), renderHtml(run, gate));

  console.log("\nGate                       actual    gate      result");
  for (const g of gate.gates) {
    const actual = g.actual === null ? "n/a" : String(g.actual);
    console.log(
      `${g.metric.padEnd(26)} ${actual.padEnd(9)} ${(g.op === "min" ? ">= " : "<= ") + g.value}`.padEnd(48) +
        (g.passed ? "pass" : "FAIL"),
    );
  }
  const changed = gate.deltas.filter((d) => d.delta !== null && d.delta !== 0);
  if (comparable) {
    console.log(`\nVersus baseline (${comparable.updatedAt}): ${changed.length ? "" : "no changes"}`);
    for (const d of changed) {
      console.log(
        `  ${d.metric.padEnd(26)} ${String(d.baseline).padEnd(8)} -> ${String(d.current).padEnd(8)} (${d.delta! > 0 ? "+" : ""}${d.delta})${d.regressed ? "  REGRESSION" : ""}`,
      );
    }
  } else if (note) console.log(`\n${note}`);

  const failed = run.cases.filter((c) => !c.passed);
  if (failed.length) {
    console.log(`\nFailed cases (${failed.length}):`);
    for (const c of failed) console.log(`  ${c.id.padEnd(10)} ${c.failures.join("; ")}`);
  }
  console.log(`\nReports: reports/eval-report.md, reports/eval-report.json, reports/eval-report.html`);

  if (updateBaseline) {
    const baseline: Baseline = {
      provider: run.provider,
      model: run.model,
      updatedAt: run.startedAt.slice(0, 10),
      metrics: run.metrics,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log("baseline.json updated.");
  }
  console.log(`\nEVAL ${gate.passed ? "PASSED" : "FAILED"}`);
  return gate.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Eval aborted: ${(err as Error).message}`);
    process.exit(2);
  },
);
