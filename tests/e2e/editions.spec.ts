import { test, expect } from "@playwright/test";
test("service pages load without identity setup and private actions require a session", async ({ page, request }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  for (const [path, heading] of [["/network", "Network & services."], ["/help", "Make together. Agree together."], ["/earnings", "Earnings."]]) {
    const response = await page.goto(path); expect(response?.status()).toBe(200);
    await expect(page.locator("main:visible").getByRole("heading", { name: heading, exact: true })).toBeVisible();
    if (path === "/network") {
      await expect(page.locator("main:visible")).not.toContainText(/World ID|Agent Pass|identity verification/i);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("network-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  }
  for (const path of ["/api/personhood", "/api/agent-pass", "/api/agent-pass/callback"]) {
    expect((await request.get(path)).status()).toBe(404);
    expect((await request.post(path, { data: {} })).status()).toBe(404);
  }
  await page.goto("/approval/missing-request");
  await expect(page.locator("main:visible").getByRole("heading", { name: "This page wandered off" })).toBeVisible();
  const authorization = await request.post("/api/market/authorization", { data: { action: "purchase" }, headers: { Origin: "http://127.0.0.1:3100" } });
  expect(authorization.status()).toBe(401);
  const denied = await request.post("/api/recommendations", { data: { interests: "fantasy" }, headers: { Origin: "http://127.0.0.1:3100" } }); expect(denied.status()).toBe(401);
  expect(errors).toEqual([]);
});
test("fixed-price marketplace and reading library work on desktop and mobile", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/marketplace"); const main = page.locator("main:visible");
  await expect(main.getByRole("heading", { name: "The comic library.", exact: true })).toBeVisible();
  await expect(main).toContainText("fixed price");
  await expect(main.getByRole("tab", { name: /auction|resale/i })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Library", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Your reading library.", exact: true })).toBeVisible();
  await expect(main).not.toContainText(/trade is locked|bid on|auction/i);
  await page.screenshot({ path: info.outputPath("library-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("library-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
