import { test, expect } from "@playwright/test";

test("wallet providers prerender without unstable-value errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /unstable value|blocking-prerender|hydration/i.test(message.text())) errors.push(message.text());
  });
  for (const path of ["/", "/marketplace", "/trade"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main:visible").getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled();
    await expect(page.locator("nextjs-portal").getByText(/Next.js encountered the unstable value/)).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Connect a Wallet" })).toBeVisible();
  expect(errors).toEqual([]);
});
