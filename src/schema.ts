import { z } from "zod";

export const INTENTS = ["billing", "shipping", "returns", "account", "product", "other"] as const;
export type Intent = (typeof INTENTS)[number];

/** The contract every copilot response must satisfy. */
export const CopilotOutputSchema = z
  .object({
    intent: z.enum(INTENTS),
    answer: z.string().min(1).max(1200),
    citations: z.array(z.string().min(1)).max(5),
    escalate: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type CopilotOutput = z.infer<typeof CopilotOutputSchema>;

export interface ValidationResult {
  ok: boolean;
  value?: CopilotOutput;
  errors: string[];
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and leading prose). */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Parses and validates a raw model reply.
 * Schema rules come from zod; the semantic rule (citations must be documents we actually retrieved)
 * is checked here because zod does not know which documents were retrieved for this request.
 */
export function validateOutput(raw: string, allowedCitations: readonly string[]): ValidationResult {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] };
  }
  const result = CopilotOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const unknown = result.data.citations.filter((c) => !allowedCitations.includes(c));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`citations not in the retrieved documents: ${unknown.join(", ")}`],
    };
  }
  return { ok: true, value: result.data, errors: [] };
}

/** Returned when the model output is still invalid after the repair retry. */
export const SAFE_FALLBACK: CopilotOutput = {
  intent: "other",
  answer: "Sorry, I could not process that request. I have passed it to a member of our support team.",
  citations: [],
  escalate: true,
  confidence: 0,
};
