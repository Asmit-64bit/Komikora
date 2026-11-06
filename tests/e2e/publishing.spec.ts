import { test, expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { installWallet } from "./wallet";

test("review explains its blockers, keeps the rights checkbox inline, and saves from the review tab", async ({ page }) => {
  await installWallet(page, [privateKeyToAccount(generatePrivateKey())]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator("main:visible").getByRole("button", { name: "New project", exact: true }).click();
  await dialog.getByLabel("Give your comic a name").fill("Publishing readiness");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\//);
  await page.getByRole("radio", { name: "Upload images one by one", exact: true }).click();
  const art = await sharp({ create: { width: 100, height: 120, channels: 3, background: "#5577aa" } }).png().toBuffer();
  await page.getByLabel("Upload artwork for panel 1").setInputFiles({ name: "panel.png", mimeType: "image/png", buffer: art });
  await page.getByRole("tab", { name: "Review & publish" }).click();
  const review = page.locator(".review-surface");
  const requirements = review.getByRole("status");
  const submit = review.getByRole("button", { name: "Submit for curator review", exact: true });
  await expect(requirements).toContainText("Save your latest comic changes");
  await expect(requirements).toContainText("Add artwork to every panel");
  const rights = review.getByRole("checkbox");
  await rights.check();
  await expect(requirements).not.toContainText("Confirm that you have permission");
  await expect(submit).toBeDisabled();
  const setup = review.getByRole("link", { name: "View publishing setup" });
  if (await setup.count()) await expect(requirements).toContainText("waiting for its contract deployment");
  await expect(submit).toHaveAttribute("aria-describedby", await requirements.getAttribute("id") || "");
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const boxes = await rights.evaluate(input => ({ input: input.getBoundingClientRect().toJSON(), text: input.nextElementSibling!.getBoundingClientRect().toJSON() }));
    expect(boxes.input.width).toBe(18);
    expect(boxes.text.left).toBeGreaterThan(boxes.input.right);
    expect(Math.abs(boxes.input.top - boxes.text.top)).toBeLessThan(8);
  }
  await review.getByRole("button", { name: "Save latest changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "All changes saved", exact: true })).toBeDisabled();
  await expect(page.locator(".review-surface").getByRole("status")).not.toContainText("Save your latest comic changes");
  await page.reload();
  await page.getByRole("radio", { name: "Upload images one by one", exact: true }).click();
  for (let i = 1; i < 4; i++) {
    await page.locator(".panel-picker button").nth(i).click();
    await page.getByLabel(`Upload artwork for panel ${i + 1}`).setInputFiles({ name: `panel-${i + 1}.png`, mimeType: "image/png", buffer: art });
  }
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "All changes saved", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Review & publish" }).click();
  await expect(page.locator(".review-preview img").first()).toBeVisible();
  await page.locator(".review-surface").getByRole("checkbox").check();
  if (!await page.locator(".review-surface").getByRole("link", { name: "View publishing setup" }).count())
    await expect(page.getByRole("button", { name: "Submit for curator review", exact: true })).toBeEnabled();
});
