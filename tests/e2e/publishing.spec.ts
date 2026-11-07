import { test, expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { installWallet } from "./wallet";

test("publishing uses a saved fixed price and team review instead of edition supply or auctions", async ({ page }) => {
  await installWallet(page, [privateKeyToAccount(generatePrivateKey())]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose a username" }).getByRole("button", { name: "Maybe later" }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator("main:visible").getByRole("button", { name: "New project", exact: true }).click();
  await dialog.getByLabel("Give your comic a name").fill("Collaborative fixed-price publication");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\//);
  await page.getByRole("radio", { name: "Upload images one by one", exact: true }).click();
  const art = await sharp({ create: { width: 100, height: 120, channels: 3, background: "#5577aa" } }).png().toBuffer();
  for (let i = 0; i < 4; i++) { await page.locator(".panel-picker button").nth(i).click(); await page.getByLabel(`Upload artwork for panel ${i + 1}`).setInputFiles({ name: `panel-${i + 1}.png`, mimeType: "image/png", buffer: art }); }
  await page.getByRole("tab", { name: "Review & publish" }).click();
  const review = page.locator(".review-surface");
  await expect(review.getByRole("button", { name: "Start team review", exact: true })).toBeDisabled();
  await expect(review.getByRole("status")).toContainText("positive fixed reading price");
  await expect(review.getByRole("spinbutton")).toHaveCount(0);
  await expect(review).not.toContainText(/auction|edition supply/i);
  await page.getByRole("tab", { name: "Team & shares" }).click();
  await page.getByLabel("Fixed reading price (test ETH)").fill("0.005");
  await page.getByRole("tab", { name: "Review & publish" }).click();
  await review.getByRole("button", { name: "Save latest changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "All changes saved", exact: true })).toBeDisabled();
  await expect(review).toContainText("Reading price: 0.005 ETH");
  await expect(review).not.toContainText("positive fixed reading price");
  await page.reload();
  await page.getByRole("tab", { name: "Team & shares" }).click();
  await expect(page.getByLabel("Fixed reading price (test ETH)")).toHaveValue("0.005");
  await page.getByRole("tab", { name: "Review & publish" }).click();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) { await page.setViewportSize(viewport); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await expect(page.getByRole("link", { name: "Trade", exact: true })).toHaveCount(0);
  await expect(page.locator('nav a[href="/library"]')).toBeAttached();
});

test("each collaborator approves separately before curator submission unlocks", async ({ page, browser }) => {
  test.setTimeout(90000);
  const owner = privateKeyToAccount(generatePrivateKey()), artist = privateKeyToAccount(generatePrivateKey());
  const context = await browser.newContext(); const collaborator = await context.newPage();
  async function signin(target: typeof page) {
    await target.goto("http://127.0.0.1:3100/");
    await target.getByRole("button", { name: "Connect wallet", exact: true }).click();
    const dialog = target.getByRole("dialog"); await dialog.getByRole("button", { name: "Test Wallet", exact: true }).click();
    await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
    await target.getByRole("dialog", { name: "Choose a username" }).getByRole("button", { name: "Maybe later" }).click();
  }
  async function post(target: typeof page, body: object) {
    const response = await target.request.post("http://127.0.0.1:3100/api/studio", { headers: { Origin: "http://127.0.0.1:3100" }, data: body });
    const result = await response.json(); expect(response.status(), result.error).toBe(200); return result;
  }
  try {
    await installWallet(page, [owner]); await installWallet(collaborator, [artist]); await signin(page); await signin(collaborator);
    const { id } = await post(page, { action: "create", title: "Everyone gets a say", genre: "Original" });
    const { token } = await post(page, { action: "invite", id, address: artist.address }); await post(collaborator, { action: "accept", token });
    const projects = (await (await page.request.get("/api/studio")).json()).projects;
    const project = projects.find((p: { id: string }) => p.id === id);
    const art = await sharp({ create: { width: 100, height: 120, channels: 3, background: "#5577aa" } }).jpeg().toBuffer();
    await post(page, { action: "save", id, revision: project.revision, title: project.title, description: "A two-person comic", terms: "Personal reading license", priceWei: "5000000000000000", panels: [{ image: `data:image/jpeg;base64,${art.toString("base64")}`, dialogue: "Made together.", alt: "Generated test panel" }], members: project.members.map((m: object, index: number) => ({ ...m, share: index ? 4000 : 6000 })) });
    await page.goto(`/projects/${id}`); await page.getByRole("tab", { name: "Review & publish" }).click();
    const review = page.locator(".review-surface"); const start = review.getByRole("button", { name: "Start team review", exact: true });
    if (await review.getByRole("link", { name: "View publishing setup" }).count()) test.skip(true, "Requires a configured reading deployment for wallet approvals.");
    await start.click(); await expect(review).toContainText("Collaborator approvals · 0/2");
    const submit = review.getByRole("button", { name: "Submit approved comic for curator review", exact: true }); await expect(submit).toBeDisabled();
    await review.getByRole("checkbox").check(); await review.getByRole("button", { name: "Approve publication", exact: true }).click();
    await expect(review).toContainText("Collaborator approvals · 1/2", { timeout: 20000 }); await expect(submit).toBeDisabled();
    await collaborator.goto(`http://127.0.0.1:3100/projects/${id}`); await collaborator.getByRole("tab", { name: "Review & publish" }).click();
    const theirReview = collaborator.locator(".review-surface"); await expect(theirReview).toContainText("Collaborator approvals · 1/2");
    await expect(theirReview.getByRole("button", { name: "Submit approved comic for curator review", exact: true })).toHaveCount(0);
    await theirReview.getByRole("checkbox").check(); await theirReview.getByRole("button", { name: "Approve publication", exact: true }).click();
    await expect(theirReview).toContainText("Collaborator approvals · 2/2", { timeout: 20000 });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".review-surface")).toContainText("Collaborator approvals · 2/2");
    await expect(page.getByRole("button", { name: "Submit approved comic for curator review", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Reopen and reset all approvals", exact: true }).click();
    await page.getByRole("tab", { name: "Review & publish" }).click();
    await expect(page.getByRole("button", { name: "Start team review", exact: true })).toBeVisible();
    const latest = (await (await page.request.get("/api/studio")).json()).projects.find((p: { id: string }) => p.id === id);
    expect(latest.reading).toBeUndefined(); expect(latest.approvals).toEqual([]);
  } finally { await context.close(); }
});
