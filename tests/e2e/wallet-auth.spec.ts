import { test, expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToString, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { installWallet, type WalletTestWindow } from "./wallet";

test("a deployment storage failure shows the actual sign-in error", async ({ page }) => {
  await installWallet(page, [privateKeyToAccount(generatePrivateKey())]);
  await page.route("**/api/studio", async route => {
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    if (body?.action === "logout") return route.fulfill({ status: 503, json: { error: "Sign-in is unavailable: connect a persistent PostgreSQL database." } });
    return route.continue();
  });
  await page.goto("/"); await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "connect a persistent PostgreSQL database" })).toBeVisible();
});

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
  await page.getByRole("dialog", { name: "Choose a username" }).getByRole("button", { name: "Maybe later" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const requests = await page.evaluate(() => (window as unknown as WalletTestWindow).walletTest.getRequests());
  // Audit attempted requests too: a rejected transaction must not hide behind
  // an otherwise successful login. Signing in only requests a SIWE signature.
  const signingRequests = requests.filter(({ method }) => /sign|sendTransaction|sendCalls/i.test(method));
  expect(signingRequests.map(({ method }) => method)).toEqual(["personal_sign", "personal_sign"]);
  for (const { params } of signingRequests) {
    const message = parseSiweMessage(hexToString(params[0] as Hex));
    expect(message.domain).toBe(new URL(page.url()).host);
    expect(message.uri).toBe(new URL(page.url()).origin);
    expect(message.address?.toLowerCase()).toBe(String(params[1]).toLowerCase());
    expect(message.chainId).toBe(1);
    expect(message.statement).toBe("Sign in to ConsentCraft. This message does not authorize transactions or cost gas.");
  }
  await page.screenshot({ path: testInfo.outputPath("wallet-studio.png") });
  await page.getByRole("button", { name: "Open account", exact: true }).click();
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
