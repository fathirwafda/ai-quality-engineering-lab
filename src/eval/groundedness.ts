import type { KbDoc } from "../kb";
import { splitSentences, tokenize } from "../text";

export interface GroundednessResult {
  /** Supported claim sentences / claim sentences. null when the answer has no claims to check. */
  score: number | null;
  claims: number;
  unsupported: string[];
}

/**
 * Sentences that carry no factual claim about the store (hand-offs, refusals, empathy).
 * They are skipped, otherwise every escalation would look "ungrounded".
 */
export const NON_CLAIM_PATTERNS: RegExp[] = [
  /\bsupport team\b/i,
  /\bcan only help\b/i,
  /\bdo not have that information\b/i,
  /\bunderstand this is frustrating\b/i,
  /\bsorry\b/i,
];

/**
 * Lexical groundedness: a sentence is supported when at least `threshold` of its content words appear
 * in the cited documents. Cheap and deterministic, but blind to paraphrase and to negation
 * ("is refunded" vs "is not refunded" look the same). See README, "Limits of lexical groundedness".
 */
export function lexicalGroundedness(answer: string, citedDocs: KbDoc[], threshold = 0.6): GroundednessResult {
  const support = new Set(citedDocs.flatMap((d) => tokenize(`${d.title} ${d.body}`)));
  const unsupported: string[] = [];
  let claims = 0;
  for (const sentence of splitSentences(answer)) {
    if (NON_CLAIM_PATTERNS.some((p) => p.test(sentence))) continue;
    const tokens = tokenize(sentence);
    if (tokens.length < 3) continue;
    claims++;
    const covered = tokens.filter((t) => support.has(t)).length / tokens.length;
    if (covered < threshold) unsupported.push(sentence);
  }
  if (claims === 0) return { score: null, claims, unsupported };
  return { score: (claims - unsupported.length) / claims, claims, unsupported };
}
