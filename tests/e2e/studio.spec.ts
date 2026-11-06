import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";

test("accounts, saved artwork, invitations, collaboration, and conflict recovery", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${Date.now()}`;
  const ownerEmail = `owner-${suffix}@example.test`;
  const collaboratorEmail = `collaborator-${suffix}@example.test`;
  const password = "local-studio-test-password";
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const main = (target: Page) => target.locator("main:visible");
  async function signup(target: Page, name: string, email: string) {
    const dialog = target.getByRole("dialog");
    await dialog.getByLabel("Your name").fill(name);
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Join the studio" }).click();
  await signup(page, "Studio Owner", ownerEmail);
  await main(page).getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("Give your comic a name").fill("A saved collaboration");
  await create.getByLabel("What’s the idea?").fill("A story made by two people.");
  await create.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\//);
  const projectUrl = page.url();
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
  await main(page).getByLabel("Collaborator email", { exact: true }).fill(collaboratorEmail);
  await main(page).getByRole("button", { name: "Create invite", exact: true }).click();
  const invitationInput = main(page).getByLabel("Invitation link");
  await expect(invitationInput).toHaveValue(/\/invites\//);
  const inviteUrl = await invitationInput.inputValue();
  await expect(main(page).locator(".pending-invite")).toHaveCount(1);

  const collaboratorContext = await browser.newContext();
  const collaborator = await collaboratorContext.newPage();
  collaborator.on("pageerror", error => errors.push(error.message));
  try {
    await collaborator.goto(inviteUrl);
    await main(collaborator).getByRole("button", { name: "Sign in or create account" }).click();
    await signup(collaborator, "Studio Collaborator", collaboratorEmail);
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
    await main(page).getByRole("spinbutton", { name: "Share for Studio Owner %", exact: true }).fill("60");
    await main(page).getByRole("spinbutton", { name: "Share for Studio Collaborator %", exact: true }).fill("40");
    await main(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main(page).getByRole("button", { name: "All changes saved" })).toBeDisabled();
    await main(page).getByLabel("Collaborator email", { exact: true }).fill(`cancel-${suffix}@example.test`);
    await main(page).getByRole("button", { name: "Create invite", exact: true }).click();
    await expect(main(page).locator(".pending-invite")).toHaveCount(1);
    await main(page).locator(".pending-invite").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(main(page).locator(".pending-invite")).toHaveCount(0);
    await expect(main(page).getByLabel("Invitation link")).toHaveCount(0);
    await main(page).getByLabel("Collaborator email", { exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("studio-team-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("studio-team-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(/\/$/);
    await expect(main(page).getByRole("heading", { name: "Good stories start together." })).toBeVisible();
    await page.getByRole("button", { name: "Join the studio" }).click();
    const login = page.getByRole("dialog");
    await login.getByRole("button", { name: "Already have an account? Sign in" }).click();
    await login.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await login.getByLabel("Password", { exact: true }).fill(password);
    await login.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(login).not.toBeVisible();
    await page.goto(projectUrl);
    await expect(main(page).getByLabel("Dialogue or caption")).toHaveValue("A collaborator was here.");
    expect(errors).toEqual([]);
  } finally { await collaboratorContext.close(); }
});
