import { describe, expect, it } from "vitest";
import { detectPii, luhnValid, redactPii } from "../src/pii";

describe("PII redaction", () => {
  it.each([
    ["4111 1111 1111 1111", "card"],
    ["5555-5555-5555-4444", "card"],
    ["378282246310005", "card"],
    ["jamie.rivera@example.com", "email"],
    ["+61 412 345 678", "phone"],
    ["(02) 9876 5432", "phone"],
  ])("detects %s as %s", (value, kind) => {
    expect(detectPii(`text ${value} text`).map((m) => m.kind)).toContain(kind);
  });

  it.each([
    ["an order number", "Order JS-10293 has not arrived"],
    ["a 16 digit number that fails the Luhn check", "Reference 1234 5678 9012 3456"],
    ["prices and dates", "It cost $49.95 on 12/03/2026 and took 3 to 5 days"],
  ])("does not flag %s", (_, text) => {
    expect(detectPii(text)).toEqual([]);
  });

  it("redacts every occurrence and keeps the rest of the message", () => {
    const { text, found } = redactPii("Card 4111 1111 1111 1111, email a@b.co, again 4111 1111 1111 1111.");
    expect(text).toBe("Card [REDACTED_CARD], email [REDACTED_EMAIL], again [REDACTED_CARD].");
    expect(found.map((f) => f.kind).sort()).toEqual(["card", "card", "email"]);
  });

  it("implements the Luhn check", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});
