import { seededRandom, hashString } from "../text";

/**
 * Metamorphic relations: transformations that must not change the intent.
 * We do not need to know the right answer for the transformed message, only that it matches the
 * answer for the original. That gives many extra checks from each golden case for free.
 */
export interface Transform {
  name: string;
  apply(message: string): string;
}

/** Swaps two neighbouring letters inside the longest word: "shipping" -> "shpiping". Deterministic per message. */
export function typo(message: string): string {
  const words = message.split(" ");
  let longest = 0;
  words.forEach((w, i) => {
    if (w.replace(/\W/g, "").length > words[longest]!.replace(/\W/g, "").length) longest = i;
  });
  const word = words[longest]!;
  if (word.length < 5) return message;
  const random = seededRandom(hashString(message));
  const i = 1 + Math.floor(random() * (word.length - 3));
  words[longest] = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  return words.join(" ");
}

export const TRANSFORMS: Transform[] = [
  { name: "lowercase", apply: (m) => m.toLowerCase() },
  { name: "uppercase", apply: (m) => m.toUpperCase() },
  { name: "typo", apply: typo },
  { name: "polite-prefix", apply: (m) => `Hi there, hope you are well. ${m}` },
  { name: "noise-suffix", apply: (m) => `${m} thanks!! :) sent from my phone` },
  { name: "no-punctuation", apply: (m) => m.replace(/[?!.,']/g, "") },
];
