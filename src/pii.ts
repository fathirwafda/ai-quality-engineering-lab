/** PII detection and redaction. Used on the way in (before the prompt) and on the way out (output guard). */

export type PiiKind = "email" | "card" | "phone";

export interface PiiMatch {
  kind: PiiKind;
  value: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13 to 19 digits, optionally separated by single spaces or dashes.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
// International or local phone numbers with at least 9 digits. Order numbers are prefixed (e.g. JS-10293) so they do not match.
const PHONE = /(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function detectPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  for (const m of text.matchAll(EMAIL)) found.push({ kind: "email", value: m[0] });
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    if (luhnValid(m[0].replace(/\D/g, ""))) found.push({ kind: "card", value: m[0] });
  }
  // Long digit runs are cards or references, never phone numbers: blank them out first.
  const withoutLongNumbers = text.replace(CARD_CANDIDATE, " ");
  for (const m of withoutLongNumbers.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits >= 9 && digits <= 12) found.push({ kind: "phone", value: m[0].trim() });
  }
  return found;
}

const LABEL: Record<PiiKind, string> = {
  email: "[REDACTED_EMAIL]",
  card: "[REDACTED_CARD]",
  phone: "[REDACTED_PHONE]",
};

export function redactPii(text: string): { text: string; found: PiiMatch[] } {
  const found = detectPii(text);
  let out = text;
  // Cards first so their digits are not partly consumed by the phone pattern.
  for (const kind of ["card", "email", "phone"] as const) {
    for (const m of found.filter((f) => f.kind === kind)) out = out.split(m.value).join(LABEL[kind]);
  }
  return { text: out, found };
}
