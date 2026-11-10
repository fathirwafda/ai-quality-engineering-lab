import { z } from "zod";
import type { KbDoc } from "../kb";
import { extractJson } from "../schema";
import { completeWithRetry } from "../providers/resilience";
import type { LlmProvider } from "../providers/types";

export const JUDGE_RUBRIC = `You grade whether a customer support answer is supported by the documents it cites.

Score from 1 to 5:
5 - every factual statement is stated in the documents.
4 - all key facts are supported; a minor detail is paraphrased loosely.
3 - mostly supported, but one statement is not in the documents.
2 - several statements are not in the documents.
1 - the answer contradicts the documents or invents policies, prices, dates or codes.

Statements with no factual content (greetings, empathy, "I have passed this to our team") are ignored.
Judge only support by the documents, not tone or helpfulness. Do not reward length.
Reply with JSON only: {"score": 1-5, "unsupported": ["statement", ...]}`;

const JudgeSchema = z.object({ score: z.number().int().min(1).max(5), unsupported: z.array(z.string()) });
export type JudgeVerdict = z.infer<typeof JudgeSchema>;

/**
 * LLM-as-judge for groundedness. Only runs with a real provider (EVAL_JUDGE=1).
 * Known biases: judges favour longer answers and answers that sound like their own style, and a judge
 * from the same model family as the system under test can share its blind spots. Treat it as a second
 * signal next to the lexical check, and spot-check its verdicts by hand.
 */
export async function judgeGroundedness(
  judge: LlmProvider,
  answer: string,
  citedDocs: KbDoc[],
): Promise<JudgeVerdict | null> {
  const docs =
    citedDocs.map((d) => `<doc id="${d.id}">\n${d.body}\n</doc>`).join("\n") || "(no documents cited)";
  const result = await completeWithRetry(judge, {
    system: JUDGE_RUBRIC,
    maxTokens: 2000,
    messages: [{ role: "user", content: `${docs}\n\n<answer>\n${answer}\n</answer>` }],
  });
  try {
    const parsed = JudgeSchema.safeParse(extractJson(result.text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
