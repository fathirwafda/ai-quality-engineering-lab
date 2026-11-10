import { INTENTS } from "../schema";
import type { GateReport } from "./gate";
import { COST_LABEL } from "./pricing";
import type { EvalRun } from "./runner";

const metricLabel = (key: string) => (key === "estimatedCostUsd" ? `${COST_LABEL}, USD` : key);

const fmt = (v: number | null | undefined, digits = 3): string =>
  v === null || v === undefined ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(digits);
const signed = (v: number | null): string =>
  v === null ? "n/a" : v > 0 ? `+${fmt(v)}` : v === 0 ? "0" : fmt(v);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(run: EvalRun, gate: GateReport, note?: string): string {
  const lines: string[] = [];
  lines.push(`# Eval report: Support Copilot`, "");
  lines.push(`- Result: **${gate.passed ? "PASS" : "FAIL"}**`);
  lines.push(`- Provider: \`${run.provider}\`, model: \`${run.model}\``);
  lines.push(
    `- Golden cases: ${run.totalCases}, metamorphic checks: ${run.metamorphic.length}, consistency cases: ${run.consistency.length}`,
  );
  lines.push(`- Started: ${run.startedAt}`);
  if (note) lines.push(`- Note: ${note}`);
  lines.push("", "## Quality gates", "", "| Metric | Gate | Actual | Result |", "| --- | --- | --- | --- |");
  for (const g of gate.gates) {
    lines.push(
      `| ${g.metric} | ${g.op === "min" ? ">=" : "<="} ${g.value} | ${fmt(g.actual)} | ${g.passed ? "pass" : "**FAIL**"} |`,
    );
  }

  if (gate.deltas.length) {
    lines.push(
      "",
      "## Compared with baseline",
      "",
      "| Metric | Baseline | Current | Delta | |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const d of gate.deltas) {
      lines.push(
        `| ${d.metric} | ${fmt(d.baseline)} | ${fmt(d.current)} | ${signed(d.delta)} | ${d.regressed ? "**REGRESSION**" : ""} |`,
      );
    }
  }

  lines.push("", "## All metrics", "", "| Metric | Value |", "| --- | --- |");
  for (const [k, v] of Object.entries(run.metrics)) lines.push(`| ${metricLabel(k)} | ${fmt(v)} |`);

  lines.push(
    "",
    "## Per-intent precision and recall",
    "",
    "| Intent | Precision | Recall | F1 | Support |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const intent of INTENTS) {
    const s = run.perClass[intent];
    lines.push(`| ${intent} | ${fmt(s.precision)} | ${fmt(s.recall)} | ${fmt(s.f1)} | ${s.support} |`);
  }

  lines.push("", "## Confusion matrix", "", "Rows are expected intents, columns are predicted intents.", "");
  lines.push(
    `| expected \\ predicted | ${INTENTS.join(" | ")} |`,
    `| --- | ${INTENTS.map(() => "---").join(" | ")} |`,
  );
  for (const e of INTENTS)
    lines.push(`| **${e}** | ${INTENTS.map((p) => run.confusion[e][p] || "·").join(" | ")} |`);

  lines.push("", "## Results by category", "", "| Category | Passed | Total |", "| --- | --- | --- |");
  for (const [cat, v] of Object.entries(run.byCategory)) lines.push(`| ${cat} | ${v.passed} | ${v.total} |`);

  const failed = run.cases.filter((c) => !c.passed);
  lines.push("", `## Failed cases (${failed.length})`, "");
  if (!failed.length) lines.push("None.");
  else {
    lines.push("| Case | Category | Message | Why |", "| --- | --- | --- | --- |");
    for (const c of failed)
      lines.push(`| ${c.id} | ${c.category} | ${esc(c.message)} | ${esc(c.failures.join("; "))} |`);
  }

  const mmFailed = run.metamorphic.filter((m) => !m.ok);
  lines.push("", `## Metamorphic failures (${mmFailed.length} of ${run.metamorphic.length})`, "");
  if (!mmFailed.length) lines.push("None.");
  else {
    lines.push("| Case | Transform | Message | Original | Transformed |", "| --- | --- | --- | --- | --- |");
    for (const m of mmFailed)
      lines.push(
        `| ${m.caseId} | ${m.transform} | ${esc(m.message)} | ${m.originalIntent} | ${m.transformedIntent} |`,
      );
  }

  const ungrounded = run.cases.filter((c) => c.unsupportedSentences.length);
  lines.push("", `## Sentences the groundedness check could not support (${ungrounded.length} cases)`, "");
  if (!ungrounded.length) lines.push("None.");
  else
    for (const c of ungrounded)
      lines.push(`- ${c.id}: ${c.unsupportedSentences.map((s) => `"${esc(s)}"`).join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

/** A single self-contained HTML file (no external assets) so it can be opened from a CI artifact. */
export function renderHtml(run: EvalRun, gate: GateReport): string {
  const h = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const gateRows = gate.gates
    .map(
      (g) =>
        `<tr class="${g.passed ? "ok" : "bad"}"><td>${g.metric}</td><td>${g.op === "min" ? "&ge;" : "&le;"} ${g.value}</td><td>${fmt(g.actual)}</td><td>${g.passed ? "pass" : "FAIL"}</td><td class="why">${h(g.why)}</td></tr>`,
    )
    .join("");
  const max = Math.max(1, ...INTENTS.flatMap((e) => INTENTS.map((p) => run.confusion[e][p])));
  const confusion = INTENTS.map(
    (e) =>
      `<tr><th>${e}</th>${INTENTS.map((p) => {
        const n = run.confusion[e][p];
        const alpha = n ? 0.15 + 0.85 * (n / max) : 0;
        const tone = e === p ? "var(--ok-rgb)" : "var(--bad-rgb)";
        return `<td style="background: rgba(${tone}, ${alpha.toFixed(2)})">${n || ""}</td>`;
      }).join("")}</tr>`,
  ).join("");
  const caseRows = run.cases
    .map(
      (c) =>
        `<tr class="${c.passed ? "ok" : "bad"}"><td>${c.id}</td><td>${c.category}</td><td>${h(c.message)}</td><td>${c.expectedIntent}</td><td>${c.predictedIntent}</td><td>${c.response.output.escalate}</td><td>${h(c.response.output.citations.join(", "))}</td><td>${h(c.failures.join("; "))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copilot Eval Report</title>
<style>
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2de; --ok:#1f7a4d; --bad:#b42318; --ok-rgb:31,122,77; --bad-rgb:180,35,24; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe8; --muted:#9d9c97; --line:#2e2e2b; --ok:#4cc38a; --bad:#ff6b5e; --ok-rgb:76,195,138; --bad-rgb:255,107,94; } }
body { background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; margin:0; padding:24px 16px; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
.meta { color:var(--muted); } .verdict { font-weight:700; color:${gate.passed ? "var(--ok)" : "var(--bad)"}; }
.scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
tr.bad td:first-child { border-left:3px solid var(--bad); } tr.ok td:first-child { border-left:3px solid transparent; }
td.why { color:var(--muted); } .matrix td { text-align:center; min-width:48px; }
</style></head><body><main>
<h1>Support Copilot eval</h1>
<p class="meta"><span class="verdict">${gate.passed ? "PASS" : "FAIL"}</span> &middot; ${h(run.provider)} / ${h(run.model)} &middot; ${run.totalCases} golden cases &middot; ${run.metamorphic.length} metamorphic checks &middot; ${COST_LABEL}: ${run.metrics.estimatedCostUsd === null || run.metrics.estimatedCostUsd === undefined ? "n/a" : `$${run.metrics.estimatedCostUsd}`} &middot; ${h(run.startedAt)}</p>
<h2>Quality gates</h2><div class="scroll"><table><tr><th>Metric</th><th>Gate</th><th>Actual</th><th>Result</th><th>Why it matters</th></tr>${gateRows}</table></div>
<h2>Confusion matrix (rows expected, columns predicted)</h2><div class="scroll"><table class="matrix"><tr><th></th>${INTENTS.map((i) => `<th>${i}</th>`).join("")}</tr>${confusion}</table></div>
<h2>Cases</h2><div class="scroll"><table><tr><th>Id</th><th>Category</th><th>Message</th><th>Expected</th><th>Predicted</th><th>Escalate</th><th>Citations</th><th>Failures</th></tr>${caseRows}</table></div>
</main></body></html>
`;
}
