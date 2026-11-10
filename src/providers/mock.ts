import type { KbDoc } from "../kb";
import type { CopilotOutput, Intent } from "../schema";
import { editDistance, hashString, normalize, seededRandom, splitSentences, stem, tokenize } from "../text";
import { ProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./types";

/**
 * A deterministic, rule-based stand-in for an LLM.
 *
 * It is not trying to be clever. It exists so that the whole quality system (contract tests, evals,
 * safety suite, gates, CI) runs offline and without secrets, and so that a failing eval always means
 * "the code changed", never "the model had a bad day". The rules below are the behaviour we expect from
 * the real model; the golden set checks both against the same expectations.
 */

const INTENT_LEXICON: Record<Exclude<Intent, "other">, Record<string, number>> = {
  billing: {
    charge: 2,
    charged: 2,
    overcharged: 3,
    bill: 2,
    billing: 3,
    invoice: 3,
    receipt: 2,
    payment: 2,
    pay: 1,
    paid: 1,
    card: 1,
    paypal: 2,
    visa: 1,
    mastercard: 1,
    amex: 1,
    price: 1,
    tax: 2,
    promo: 3,
    coupon: 3,
    discount: 2,
    authorisation: 2,
    authorization: 2,
    duplicate: 2,
    twice: 1.5,
    transaction: 2,
    statement: 1,
  },
  shipping: {
    ship: 2,
    shipping: 3,
    shipped: 2,
    delivery: 3,
    deliver: 2,
    delivered: 2,
    arrive: 2,
    arrived: 2,
    tracking: 3,
    track: 2,
    package: 2,
    parcel: 2,
    courier: 2,
    carrier: 2,
    express: 2,
    dispatch: 2,
    dispatched: 2,
    international: 2,
    overseas: 2,
    abroad: 2,
    customs: 3,
    address: 2,
    late: 1,
    delayed: 2,
    lost: 1.5,
  },
  returns: {
    return: 3,
    returned: 3,
    returning: 3,
    refund: 2.5,
    refunded: 2,
    exchange: 3,
    damaged: 3,
    broken: 2,
    faulty: 2,
    defective: 2,
    wrong: 2,
    label: 1,
    swap: 2,
  },
  account: {
    account: 2.5,
    password: 3,
    login: 3,
    locked: 2,
    hacked: 3,
    verification: 2,
    profile: 2,
    unsubscribe: 3,
    newsletter: 2,
    privacy: 2,
    username: 2,
    "2fa": 3,
  },
  product: {
    size: 3,
    sizing: 3,
    fit: 2,
    fits: 2,
    wash: 2,
    care: 1.5,
    material: 2,
    wool: 2,
    linen: 2,
    warranty: 3,
    stock: 3,
    restock: 3,
    available: 1.5,
    measurement: 2,
    colour: 1,
    color: 1,
    specs: 2,
    cotton: 2,
  },
};

const INTENT_PHRASES: Array<[RegExp, Exclude<Intent, "other">, number]> = [
  [/\bgift ?cards?\b/, "billing", 3],
  [/\bcharged (me )?twice\b/, "billing", 3],
  [/\bwhere('s| is) my (order|package|parcel)\b/, "shipping", 4],
  [/\bsend (it |this |them )?back\b/, "returns", 3],
  [/\barrived (broken|damaged|faulty|cracked)\b/, "returns", 3],
  [/\b(log|sign) ?in\b/, "account", 3],
  [/\b(two[- ]step|two[- ]factor)\b/, "account", 3],
  [/\bdelete my (account|data)\b/, "account", 4],
  [/\breset (my )?password\b/, "account", 2],
  [/\bstopped working\b/, "product", 3],
  [/\bback in stock\b/, "product", 3],
];

const STEMMED_LEXICON = Object.fromEntries(
  Object.entries(INTENT_LEXICON).map(([intent, words]) => [
    intent,
    new Map(Object.entries(words).map(([w, weight]) => [stem(w), weight])),
  ]),
) as Record<Exclude<Intent, "other">, Map<string, number>>;

const OUT_OF_SCOPE =
  /\b(poem|essay|song|joke|recipe|homework|weather|bitcoin|crypto|translate|python|javascript|sql|write (me )?(some )?code)\b/;

const ESCALATION_PATTERNS: RegExp[] = [
  /\b(human|real person|a person|someone real|an agent|support agent|manager|supervisor)\b/,
  /\b(speak|talk) to (someone|somebody|a)\b/,
  /\b(fraud|fraudulent|scam|unauthori[sz]ed|stolen|did not make|didn't make|don't recognise|don't recognize)\b/,
  /\b(hacked|compromised|someone else (has )?(logged|accessed|signed))\b/,
  /\b(chargeback|lawyer|legal action|sue|court|ombudsman)\b/,
];

const TOXIC_PATTERNS: RegExp[] = [
  /\b(idiot|idiots|stupid|useless|garbage|pathetic|incompetent|morons?|trash)\b/,
  /\b(i will|i'll) (find|hurt|come for)\b/,
  /\byou('ll| will) regret\b/,
];

export const TEMPLATES = {
  refusal:
    "Sorry, I can only help with questions about Juniper Supply Co. orders, shipping, returns, billing, accounts and products.",
  handoff: "I have passed this to a member of our support team, who will reply within one business day.",
  noInfo: "I do not have that information.",
  calm: "I understand this is frustrating.",
} as const;

/**
 * The committed dataset ships with neutral placeholders instead of real attack text, for example
 * "[SIMULATED INJECTION: ...]" in a customer message or a KB document, and "[SIMULATED JAILBREAK: ...]".
 * The mock recognises these markers, which stands in for a real model recognising the attack.
 * Real red-team prompts belong in a local, gitignored file and are meant for the live-model eval
 * (see README, "Plugging in your own red-team prompts").
 */
export const ATTACK_MARKER = /\[SIMULATED (INJECTION|JAILBREAK)\b[^\]]*\]/gi;

export function containsInjection(text: string): boolean {
  return new RegExp(ATTACK_MARKER.source, "i").test(text);
}

/** Removes simulated attack spans from a message before it is classified. */
export function stripInjectedSentences(text: string): { clean: string; removed: number } {
  const removed = text.match(ATTACK_MARKER)?.length ?? 0;
  const clean = text.replace(ATTACK_MARKER, " ").replace(/\s+/g, " ").trim();
  return { clean, removed };
}

export function scoreIntents(message: string): Record<Exclude<Intent, "other">, number> {
  const text = normalize(message);
  const tokens = tokenize(message);
  const scores = { billing: 0, shipping: 0, returns: 0, account: 0, product: 0 };
  for (const intent of Object.keys(scores) as Array<keyof typeof scores>) {
    const lexicon = STEMMED_LEXICON[intent];
    for (const token of tokens) {
      const exact = lexicon.get(token);
      if (exact !== undefined) {
        scores[intent] += exact;
        continue;
      }
      // Typo tolerance: one edit away from a lexicon word of 5+ letters.
      if (token.length >= 5) {
        for (const [word, weight] of lexicon) {
          if (
            word.length >= 5 &&
            Math.abs(word.length - token.length) <= 1 &&
            editDistance(word, token) <= 1
          ) {
            scores[intent] += weight * 0.8;
            break;
          }
        }
      }
    }
  }
  for (const [pattern, intent, weight] of INTENT_PHRASES) if (pattern.test(text)) scores[intent] += weight;
  return scores;
}

function rankSentences(
  doc: KbDoc,
  queryTokens: Set<string>,
): Array<{ sentence: string; overlap: number; index: number }> {
  return splitSentences(doc.body)
    .filter((s) => !containsInjection(s))
    .map((sentence, index) => ({
      sentence,
      index,
      overlap: tokenize(sentence).filter((t) => queryTokens.has(t)).length,
    }));
}

export function decide(customerMessage: string, docs: KbDoc[]): CopilotOutput {
  const { clean, removed } = stripInjectedSentences(customerMessage);
  const text = normalize(clean);
  const wantsEscalation = ESCALATION_PATTERNS.some((p) => p.test(text));
  const toxic = TOXIC_PATTERNS.some((p) => p.test(text));
  const escalate = wantsEscalation || toxic;

  const scores = scoreIntents(clean);
  const ranked = (Object.entries(scores) as Array<[Exclude<Intent, "other">, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const [topIntent, topScore] = ranked[0]!;
  const secondScore = ranked[1]![1];

  if (OUT_OF_SCOPE.test(text) || (topScore < 1.5 && !escalate)) {
    return {
      intent: "other",
      answer: TEMPLATES.refusal,
      citations: [],
      escalate: false,
      confidence: removed > 0 || OUT_OF_SCOPE.test(text) ? 0.9 : 0.6,
    };
  }

  const intent: Intent = topScore >= 1.5 ? topIntent : "other";
  const confidence =
    intent === "other" ? 0.7 : Math.round((0.5 + (0.5 * (topScore - secondScore)) / topScore) * 100) / 100;

  // Use the retrieved documents for this intent (or the escalation doc for "other").
  const topical = docs.filter((d) => d.topic === intent);
  const chosen = topical.slice(0, 2);
  const queryTokens = new Set(tokenize(clean));
  const sentences: string[] = [];
  const citations: string[] = [];
  let firstOverlap = 0;
  for (const doc of chosen) {
    const ranked = rankSentences(doc, queryTokens)
      .filter((s) => s.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    const isFirst = citations.length === 0;
    // A second document is only cited when it is at least as relevant as the first one.
    if (!isFirst && (ranked[0]?.overlap ?? 0) < Math.max(2, firstOverlap)) continue;
    const best = ranked.slice(0, isFirst ? 2 : 1).sort((a, b) => a.index - b.index);
    if (best.length === 0) continue;
    if (isFirst) firstOverlap = ranked[0]!.overlap;
    sentences.push(...best.map((s) => s.sentence));
    citations.push(doc.id);
  }

  const parts: string[] = [];
  if (toxic) parts.push(TEMPLATES.calm);
  if (sentences.length > 0) parts.push(...sentences);
  else if (!escalate) parts.push(TEMPLATES.noInfo);
  const finalEscalate = escalate || sentences.length === 0;
  if (finalEscalate) parts.push(TEMPLATES.handoff);

  return {
    intent,
    answer: parts.join(" "),
    citations,
    escalate: finalEscalate,
    confidence: sentences.length === 0 ? Math.min(confidence, 0.4) : confidence,
  };
}

export interface MockProviderOptions {
  seed?: number;
  /** Probability (0..1) that a first attempt returns broken JSON. Exercises the repair path. */
  malformedRate?: number;
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-rules-v1";
  private readonly seed: number;
  private readonly malformedRate: number;

  constructor(options: MockProviderOptions = {}) {
    this.seed = options.seed ?? 42;
    this.malformedRate = options.malformedRate ?? 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!request.context) throw new ProviderError("bad_request", "MockProvider needs request.context");
    const { customerMessage, docs } = request.context;
    const isRepair = request.messages.length > 1;
    const random = seededRandom(this.seed ^ hashString(customerMessage));
    const output = decide(customerMessage, docs);
    let text = JSON.stringify(output);
    if (!isRepair && random() < this.malformedRate) {
      // Typical real-world failure: prose before the JSON and a truncated object.
      text = `Sure! Here is the JSON:\n${text.slice(0, Math.floor(text.length / 2))}`;
    }
    const promptChars = request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: this.model,
      usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(text.length / 4) },
    };
  }
}
