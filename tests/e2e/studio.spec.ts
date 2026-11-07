import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installWallet, type WalletTestWindow } from "./wallet";

test("accounts, saved artwork, invitations, collaboration, and conflict recovery", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const ownerWallet = privateKeyToAccount(generatePrivateKey());
  const collaboratorWallet = privateKeyToAccount(generatePrivateKey());
  const otherWallet = privateKeyToAccount(generatePrivateKey());
  const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
  await installWallet(page, [ownerWallet, otherWallet]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const main = (target: Page) => target.locator("main:visible");
  async function signin(target: Page) {
    const dialog = target.getByRole("dialog");
    await expect(dialog.getByLabel("Email", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveCount(0);
    const connect = dialog.getByRole("button", { name: /^Test Wallet(?: Recent)?$/ });
    await expect(connect.or(dialog.getByRole("button", { name: "Sign message", exact: true }))).toBeVisible();
    if (await connect.isVisible()) await connect.click();
    await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
    await expect(target.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    const username = target.getByRole("dialog", { name: "Choose a username" });
    if (await username.isVisible()) await username.getByRole("button", { name: "Maybe later" }).click();
    await expect(dialog).not.toBeVisible();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await signin(page);
  await main(page).getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("Give your comic a name").fill("A saved collaboration");
  await create.getByLabel("What’s the idea?").fill("A story made by two people.");
  await create.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\//);
  const projectUrl = page.url();
  await main(page).getByRole("radio", { name: "Upload images one by one", exact: true }).click();
  const art = await sharp({ create: { width: 200, height: 160, channels: 3, background: "#c6b3ed" } }).png().toBuffer();
  await main(page).getByLabel("Upload artwork for panel 1").setInputFiles({ name: "panel.png", mimeType: "image/png", buffer: art });
  await main(page).getByLabel("Dialogue or caption").fill("Saved beyond a reload.");
  await main(page).getByLabel("Image description").fill("A lavender panel");
  await main(page).getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(main(page).getByRole("button", { name: "All changes saved" })).toBeDisabled();
  await page.reload();
  await expect(main(page).getByLabel("Dialogue or caption")).toHaveValue("Saved beyond a reload.");
  await expect(main(page).getByLabel("Image description")).toHaveValue("A lavender panel");
  await expect(main(page).locator(".upload-area img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

  await main(page).getByRole("tab", { name: "Team & shares" }).click();
  await main(page).getByLabel("Collaborator username or wallet address", { exact: true }).fill(collaboratorWallet.address);
  await main(page).getByRole("button", { name: "Create invite", exact: true }).click();
  const invitationInput = main(page).getByLabel("Invitation link");
  await expect(invitationInput).toHaveValue(/\/invites\//);
  const inviteUrl = await invitationInput.inputValue();
  await expect(main(page).locator(".pending-invite")).toHaveCount(1);

  const collaboratorContext = await browser.newContext();
  const collaborator = await collaboratorContext.newPage();
  await installWallet(collaborator, [collaboratorWallet]);
  collaborator.on("pageerror", error => errors.push(error.message));
  try {
    await collaborator.goto(inviteUrl);
    await main(collaborator).getByRole("button", { name: "Sign in with wallet" }).click();
    await signin(collaborator);
    await main(collaborator).getByRole("button", { name: "Accept invitation", exact: true }).click();
    await collaborator.waitForURL(projectUrl);
    await expect(main(collaborator).getByLabel("Dialogue or caption")).toHaveValue("Saved beyond a reload.");
    await main(collaborator).getByRole("tab", { name: "Team & shares" }).click();
    await expect(main(collaborator).getByLabel("Comic title", { exact: true })).toBeDisabled();
    await expect(main(collaborator).getByRole("button", { name: "Create invite" })).toHaveCount(0);
    await main(collaborator).getByRole("tab", { name: "The comic", exact: true }).click();

    await page.reload();
    await main(page).getByLabel("Dialogue or caption").fill("Owner’s unsaved edit");
    await main(collaborator).getByLabel("Dialogue or caption").fill("A collaborator was here.");
    await main(collaborator).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main(collaborator).getByRole("button", { name: "All changes saved" })).toBeDisabled();
    await main(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main(page).getByRole("alert")).toContainText("changed in another session");
    await expect(main(page).getByLabel("Dialogue or caption")).toHaveValue("Owner’s unsaved edit");
    page.once("dialog", dialog => dialog.accept());
    await main(page).getByRole("button", { name: "Reload latest" }).click();
    await expect(main(page).getByLabel("Dialogue or caption")).toHaveValue("A collaborator was here.");

    await main(page).getByRole("tab", { name: "Team & shares" }).click();
    await main(page).getByRole("spinbutton", { name: `Share for ${shortAddress(ownerWallet.address)} %`, exact: true }).fill("60");
    await main(page).getByRole("spinbutton", { name: `Share for ${shortAddress(collaboratorWallet.address)} %`, exact: true }).fill("40");
    await main(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main(page).getByRole("button", { name: "All changes saved" })).toBeDisabled();
    await main(page).getByLabel("Collaborator username or wallet address", { exact: true }).fill(otherWallet.address);
    await main(page).getByRole("button", { name: "Create invite", exact: true }).click();
    await expect(main(page).locator(".pending-invite")).toHaveCount(1);
    await main(page).locator(".pending-invite").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(main(page).locator(".pending-invite")).toHaveCount(0);
    await expect(main(page).getByLabel("Invitation link")).toHaveCount(0);
    await main(page).getByLabel("Collaborator username or wallet address", { exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("studio-team-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("studio-team-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(/\/$/);
    await expect(main(page).getByRole("heading", { name: "Good stories start together." })).toBeVisible();
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await signin(page);
    await page.goto(projectUrl);
    await expect(main(page).getByLabel("Dialogue or caption")).toHaveValue("A collaborator was here.");
    // Switching accounts clears the signed session instead of reusing it.
    await page.evaluate(address => (window as unknown as WalletTestWindow).walletTest.switchAccount(address), otherWallet.address);
    await expect(main(page).getByRole("heading", { name: "Your studio is waiting" })).toBeVisible();
    await expect.poll(async () => (await (await page.request.get("/api/studio")).json()).user).toBeNull();
    await page.locator(".topbar").getByRole("button", { name: "Sign in", exact: true }).click();
    await signin(page);
    await expect(main(page).getByRole("heading", { name: "This draft is not here" })).toBeVisible();
    await page.evaluate(() => (window as unknown as WalletTestWindow).walletTest.disconnect());
    await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
    await expect.poll(async () => (await (await page.request.get("/api/studio")).json()).user).toBeNull();
    expect(errors).toEqual([]);
  } finally { await collaboratorContext.close(); }
});
