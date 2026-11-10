/** Small, dependency-free text utilities shared by retrieval, the mock provider and the eval metrics. */

export const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so that the their them then there these they this to us was we were what when where " +
    "which who why will with would you your yours am im ive id just please hi hello hey thanks thank there's " +
    "it's i'm i've don't can't any some about after before up out than too very also get got"
  ).split(/\s+/),
);

/** Very light suffix stripping. Good enough for a 15-document KB; not a real stemmer. */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  let out = token;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (out.endsWith(suffix) && out.length - suffix.length >= 4) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  // "charge", "charged" and "charges" all become "charg".
  if (out.endsWith("e") && out.length > 4) out = out.slice(0, -1);
  return out;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Lowercased word tokens, stopwords removed, lightly stemmed. */
export function tokenize(text: string): string[] {
  return (normalize(text).match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [])
    .map((t) => t.replace(/'[a-z]+$/, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Damerau-Levenshtein distance limited to small values; used for typo tolerance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i]!;
      const prev = d[i - 1]!;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

/** Deterministic PRNG (mulberry32). Same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), used to derive per-request seeds. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
