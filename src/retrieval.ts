import type { KbDoc } from "./kb";
import { tokenize } from "./text";

export interface RetrievedDoc {
  doc: KbDoc;
  score: number;
}

export interface RetrieverOptions {
  k1?: number;
  b?: number;
  /** Title terms are repeated this many times, so a title match counts more than a body match. */
  titleBoost?: number;
}

/**
 * BM25 over a small in-memory corpus. Deterministic: same corpus + query = same ranking,
 * with ties broken by document id so results never depend on file system order.
 */
export class Bm25Retriever {
  private readonly docs: KbDoc[];
  private readonly termFreqs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(docs: KbDoc[], options: RetrieverOptions = {}) {
    this.docs = docs;
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    const titleBoost = options.titleBoost ?? 2;
    this.termFreqs = docs.map((doc) => {
      const tokens = [
        ...Array(titleBoost).fill(tokenize(doc.title)).flat(),
        ...tokenize(doc.body),
      ] as string[];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.termFreqs.map((tf) => [...tf.values()].reduce((a, n) => a + n, 0));
    this.avgLength = this.lengths.reduce((a, n) => a + n, 0) / Math.max(docs.length, 1);
    for (const tf of this.termFreqs) {
      for (const term of tf.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
  }

  private idf(term: string): number {
    const n = this.docFreq.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }

  search(query: string, topK = 3, minScore = 1.0): RetrievedDoc[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    return this.docs
      .map((doc, i) => {
        const tf = this.termFreqs[i]!;
        const len = this.lengths[i]!;
        let score = 0;
        for (const term of terms) {
          const f = tf.get(term) ?? 0;
          if (f === 0) continue;
          score +=
            (this.idf(term) * (f * (this.k1 + 1))) /
            (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLength));
        }
        return { doc, score: Math.round(score * 1000) / 1000 };
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      .slice(0, topK);
  }
}
