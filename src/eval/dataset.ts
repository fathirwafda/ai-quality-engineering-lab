import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { INTENTS } from "../schema";

export const CATEGORIES = [
  "intent",
  "escalation",
  "multi_intent",
  "ambiguous",
  "out_of_scope",
  "injection",
  "pii",
  "jailbreak",
  "toxicity",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const GoldenCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z]+-\d{3}$/, "ids look like ship-001"),
    category: z.enum(CATEGORIES),
    message: z.string().min(1),
    expected: z
      .object({
        intent: z.enum(INTENTS),
        /** Other intents that also count as correct (multi-intent and ambiguous messages). */
        acceptableIntents: z.array(z.enum(INTENTS)).optional(),
        /** KB docs that are relevant. Citations outside this list count against citation precision. */
        relevantDocs: z.array(z.string()),
        /** null = either answer is fine. */
        escalate: z.boolean().nullable(),
        /** The copilot must decline (intent "other", no citations, no escalation). */
        refusal: z.boolean().optional(),
        /** Case-insensitive substrings that must not appear in the answer. */
        mustNotContain: z.array(z.string()).optional(),
      })
      .strict(),
    /** Extra KB docs (from data/fixtures/poisoned-kb) added to the corpus for this case only. */
    kbOverlay: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export const GOLDEN_DIR = join(process.cwd(), "data", "golden");

export function parseGoldenLines(text: string, source: string): GoldenCase[] {
  return text
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, n }) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`${source}:${n} is not valid JSON`);
      }
      const parsed = GoldenCaseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `${source}:${n} ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      return parsed.data;
    });
}

/** Gitignored files for your own red-team prompts, e.g. data/golden/local-adversarial.jsonl. */
export const isLocalGoldenFile = (fileName: string) => fileName.startsWith("local-");

/**
 * Loads the committed golden files. Local files (`local-*.jsonl`) are only added when asked for,
 * so the committed eval stays reproducible for everyone.
 */
export function loadGolden(dir: string = GOLDEN_DIR, options: { includeLocal?: boolean } = {}): GoldenCase[] {
  const cases = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && (options.includeLocal || !isLocalGoldenFile(f)))
    .sort()
    .flatMap((f) => parseGoldenLines(readFileSync(join(dir, f), "utf8"), f));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate golden case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

export function isAcceptableIntent(c: GoldenCase, predicted: string): boolean {
  return predicted === c.expected.intent || (c.expected.acceptableIntents ?? []).includes(predicted as never);
}
