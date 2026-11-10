import { describe, expect, it } from "vitest";
import { loadKb, parseKbDoc } from "../src/kb";
import { Bm25Retriever } from "../src/retrieval";
import { stem, tokenize } from "../src/text";

const kb = loadKb();
const retriever = new Bm25Retriever(kb);
const ids = (q: string, k = 3) => retriever.search(q, k).map((r) => r.doc.id);

describe("knowledge base", () => {
  it("has 10 to 15 documents with unique ids", () => {
    expect(kb.length).toBeGreaterThanOrEqual(10);
    expect(kb.length).toBeLessThanOrEqual(15);
    expect(new Set(kb.map((d) => d.id)).size).toBe(kb.length);
  });

  it("rejects a document without front matter", () => {
    expect(() => parseKbDoc("just text", "bad.md")).toThrow(/front matter/);
  });
});

describe("tokenizer", () => {
  it("drops stopwords and stems plural and past forms to the same token", () => {
    expect(tokenize("Where is my package?")).toEqual(["packag"]);
    expect(stem("charged")).toBe(stem("charges"));
    expect(stem("charge")).toBe(stem("charged"));
  });
});

describe("BM25 retrieval", () => {
  it.each([
    ["How do I reset my password?", "account-access"],
    ["How much is international shipping?", "shipping-international"],
    ["I was charged twice", "billing-charges"],
    ["when will my refund arrive", "refunds-timeline"],
    ["is my kettle covered by the warranty", "product-warranty-stock"],
  ])("ranks the right document first for %j", (query, expected) => {
    expect(ids(query)[0]).toBe(expected);
  });

  it("is deterministic and breaks ties by id", () => {
    const first = retriever.search("order", 15);
    const second = new Bm25Retriever([...kb].reverse()).search("order", 15);
    expect(second.map((r) => r.doc.id)).toEqual(first.map((r) => r.doc.id));
  });

  it("returns nothing for an empty or stopword-only query", () => {
    expect(retriever.search("")).toEqual([]);
    expect(retriever.search("is it the")).toEqual([]);
  });

  it("respects topK and the minimum score", () => {
    expect(retriever.search("shipping delivery order", 2)).toHaveLength(2);
    expect(retriever.search("zebra quantum", 3)).toEqual([]);
  });
});
