import { test, expect } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { zipSync, strToU8 } from "fflate";
import sharp from "sharp";
import { installWallet } from "./wallet";

function comicPdf() {
  const page = (content: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << /Font << /F1 7 0 R >> >> /Contents ${content} 0 R >>`;
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    page(4), stream("0.2 0.4 0.8 rg 0 0 240 320 re f BT /F1 18 Tf 20 280 Td (Page one) Tj ET"),
    page(6), stream("0.8 0.3 0.2 rg 0 0 240 320 re f BT /F1 18 Tf 20 280 Td (Page two) Tj ET"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function comicEpub() {
  const cover = await sharp({ create: { width: 160, height: 200, channels: 3, background: "#5eead4" } }).png().toBuffer();
  const page = (image: string) => strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/${image}"/></body></html>`);
  return Buffer.from(zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8('<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="images/one.png" media-type="image/png"/><item id="second" href="images/two.png" media-type="image/png"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'),
    "OEBPS/one.xhtml": page("one.png"), "OEBPS/two.xhtml": page("two.png"),
    "OEBPS/images/one.png": cover, "OEBPS/images/two.png": cover,
  }));
}

test("PDF and EPUB imports render pages and survive saving and reload", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const workers: number[] = [];
  page.on("response", response => { if (response.url().includes("pdf.worker")) workers.push(response.status()); });
  await installWallet(page, [privateKeyToAccount(generatePrivateKey())]);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Test Wallet(?: Recent)?$/ }).click();
  await dialog.getByRole("button", { name: "Sign message", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const main = page.locator("main:visible");
  await main.getByRole("button", { name: "New project", exact: true }).click();
  await dialog.getByLabel("Give your comic a name").fill("Document import fixture");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\//);
  await main.getByLabel("Upload a PDF or EPUB").setInputFiles({ name: "comic.pdf", mimeType: "application/pdf", buffer: comicPdf() });
  await expect(main.getByRole("status")).toContainText("Imported 2 pages", { timeout: 60_000 });
  await expect(main.locator(".panel-picker button")).toHaveCount(2);
  expect(workers.length).toBeGreaterThan(0);
  expect(workers.every(status => status === 200)).toBe(true);
  await main.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(main.getByRole("button", { name: "All changes saved", exact: true })).toBeDisabled();
  await page.reload();
  await expect(main.locator(".panel-picker button")).toHaveCount(2);
  const pdfCover = await main.locator(".upload-area.has-image img").getAttribute("src");
  page.once("dialog", prompt => prompt.accept());
  await main.getByLabel("Upload a PDF or EPUB").setInputFiles({ name: "comic.epub", mimeType: "application/epub+zip", buffer: await comicEpub() });
  await expect(main.getByRole("status")).toContainText("Imported 2 pages");
  await expect(main.locator(".upload-area.has-image img")).not.toHaveAttribute("src", pdfCover!);
  await main.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(main.getByRole("button", { name: "All changes saved", exact: true })).toBeDisabled();
  await page.reload();
  await expect(main.locator(".panel-picker button")).toHaveCount(2);
  await expect(main.locator(".upload-area.has-image img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  expect(errors).toEqual([]);
});
