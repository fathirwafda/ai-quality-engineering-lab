import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTENTS, type Intent } from "./schema";

export interface KbDoc {
  id: string;
  title: string;
  topic: Intent;
  body: string;
}

export const KB_DIR = join(process.cwd(), "data", "kb");
export const POISONED_KB_DIR = join(process.cwd(), "data", "fixtures", "poisoned-kb");

export function parseKbDoc(markdown: string, fileName = "(inline)"): KbDoc {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${fileName}: missing front matter`);
  const meta = Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const idx = line.indexOf(":");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
  );
  const { id, title, topic } = meta as Record<string, string | undefined>;
  if (!id || !title || !topic) throw new Error(`${fileName}: front matter needs id, title and topic`);
  if (!(INTENTS as readonly string[]).includes(topic)) throw new Error(`${fileName}: unknown topic ${topic}`);
  return { id, title, topic: topic as Intent, body: match[2]!.trim() };
}

export function loadKb(dir: string = KB_DIR): KbDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseKbDoc(readFileSync(join(dir, f), "utf8"), f));
}

export function loadKbDoc(dir: string, id: string): KbDoc {
  const doc = loadKb(dir).find((d) => d.id === id);
  if (!doc) throw new Error(`KB doc ${id} not found in ${dir}`);
  return doc;
}
