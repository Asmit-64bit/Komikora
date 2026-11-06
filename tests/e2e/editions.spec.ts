import { test, expect } from "@playwright/test";
test("service and approval links resolve and private actions require a session", async ({ page, request }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  for (const [path, heading] of [["/network", "Network & services."], ["/help", "Make together. Agree together."], ["/approval/missing-request", "Approve this publication"]]) {
    const response = await page.goto(path); expect(response?.status()).toBe(200);
    await expect(page.locator("main:visible").getByRole("heading", { name: heading, exact: true })).toBeVisible();
    if (path === "/network") {
      await expect(page.locator("main:visible").getByRole("heading", { name: /^World ID Agent Pass/ })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("network-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  }
  await expect(page.locator("main:visible").getByRole("alert")).toContainText(/Sign in/);
  await page.goto("/api/agent-pass/callback?error=access_denied");
  await expect(page).toHaveURL(/\/network\?approval=failed$/);
  await expect(page.locator("main:visible").getByRole("alert")).toContainText("World ID approval could not be completed");
  const denied = await request.post("/api/recommendations", { data: { interests: "fantasy" }, headers: { Origin: "http://127.0.0.1:3100" } }); expect(denied.status()).toBe(401);
  expect(errors).toEqual([]);
});
test("NFT marketplace and trade routes remain usable on desktop and mobile", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/marketplace"); const main = page.locator("main:visible");
  await expect(main.getByRole("heading", { name: "The marketplace.", exact: true })).toBeVisible();
  await expect(main.getByText(/NFT editions have not launched/).or(main.getByRole("tab", { name: "First-sale auctions", exact: true }))).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Trade (locked)", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Trade is locked.", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Explore Marketplace →" })).toHaveAttribute("href", "/marketplace");
  await expect(main.getByRole("tab", { name: "First-sale auctions" })).toHaveCount(0);
  await expect(main.getByRole("tab", { name: "Resales" })).toHaveCount(0);
  await page.reload();
  await expect(main.getByRole("heading", { name: "Trade is locked.", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("trade-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("trade-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
