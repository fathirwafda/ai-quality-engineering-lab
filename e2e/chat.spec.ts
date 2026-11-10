import { expect, test } from "@playwright/test";

/**
 * E2E for an AI feature: assert on the contract the UI depends on (intent, escalation, sources),
 * not on exact wording, which a real model would change from run to run.
 */
test.describe("Support Copilot chat page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("answers a shipping question with a cited source", async ({ page }) => {
    await page.getByTestId("message").fill("How long does standard shipping take?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("intent")).toHaveText("intent: shipping");
    await expect(page.getByTestId("escalate")).toHaveText("self-serve");
    await expect(page.getByTestId("citations")).toContainText("shipping-options");
    await expect(page.getByTestId("answer")).toContainText("business days");
  });

  test("hands a fraud report to a person", async ({ page }) => {
    await page.getByTestId("message").fill("There is a charge on my card that I did not make");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("escalate")).toHaveText("handed to a person");
  });

  test("never shows the customer's card number back", async ({ page }) => {
    await page.getByTestId("message").fill("My card 4111 1111 1111 1111 was charged twice");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("result")).toBeVisible();
    await expect(page.getByTestId("result")).not.toContainText("4111");
  });

  test("rejects an empty request at the API", async ({ request }) => {
    const res = await request.post("/api/chat", { data: { message: "  " } });
    expect(res.status()).toBe(400);
  });
});
