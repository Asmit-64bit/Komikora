import { test, expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installWallet, type WalletTestWindow } from "./wallet";

test("rejecting a signature does not log in, and retry succeeds", async ({ page }, testInfo) => {
  await installWallet(page, [privateKeyToAccount(generatePrivateKey())]);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Test Wallet", exact: true }).click();
  expect((await (await page.request.get("/api/studio")).json()).user).toBeNull();
  await page.evaluate(() => (window as unknown as WalletTestWindow).walletTest.rejectNextSignature());
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign message", exact: true })).toBeEnabled();
  await expect(dialog.getByText("Verify your account", { exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/studio")).json()).user).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("wallet-sign-message.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("wallet-sign-message-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wallet-studio.png") });
  await page.getByTestId("rk-account-button").click();
  await expect(dialog.getByRole("button", { name: /^Disconnect(?: Disconnect)?$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wallet-account-mobile.png") });
  await dialog.getByRole("button", { name: /^Disconnect(?: Disconnect)?$/ }).click();
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/studio")).json()).user).toBeNull();
});

test("a missing browser wallet shows a helpful message with no password fallback", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('input[type="email"],input[type="password"]')).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Connect a Wallet" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wallet-connect.png") });
  await dialog.getByRole("button", { name: "Rabby Wallet", exact: true }).click();
  await expect(dialog.getByText("Get Rabby Wallet", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Add to Chrome", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wallet-sign-in.png") });
  expect((await (await page.request.get("/api/studio")).json()).user).toBeNull();
});
