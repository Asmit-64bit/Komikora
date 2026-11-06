"use client";
// Turns a PDF or EPUB into page images in the browser, matching the panel
// format the studio already stores (JPEG data URLs, max 1400px on the long edge).
import { unzipSync, strFromU8 } from "fflate";

export const MAX_PAGES = 24;
const MAX_EDGE = 1400;
const QUALITY = 0.84;
export const MAX_DOCUMENT_BYTES = 80 * 1024 * 1024;

export type ImportResult = { images: string[]; totalPages: number };

function toJpeg(source: CanvasImageSource, width: number, height: number): string {
  const ratio = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", QUALITY);
}

export async function importPdf(file: File, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const total = Math.min(pdf.numPages, MAX_PAGES);
    const images: string[] = [];
    for (let n = 1; n <= total; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", QUALITY));
      page.cleanup();
      onProgress?.(n, total);
    }
    return { images, totalPages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

function resolvePath(base: string, href: string): string {
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "").concat(decodeURIComponent(href.split("#")[0])).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

export async function importEpub(file: File, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch { throw new Error("This EPUB could not be opened."); }
  const parser = new DOMParser();
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error("This EPUB is missing its table of contents.");
  const opfPath = parser.parseFromString(strFromU8(container), "application/xml").querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath || !files[opfPath]) throw new Error("This EPUB is missing its table of contents.");
  const opf = parser.parseFromString(strFromU8(files[opfPath]), "application/xml");
  const manifest = new Map<string, { href: string; type: string }>();
  opf.querySelectorAll("manifest > item").forEach(item => {
    const id = item.getAttribute("id"); const href = item.getAttribute("href");
    if (id && href) manifest.set(id, { href: resolvePath(opfPath, href), type: item.getAttribute("media-type") || "" });
  });

  // Walk the reading order and collect every image each page references.
  const ordered: string[] = [];
  const add = (path: string) => { if (files[path] && !ordered.includes(path) && IMAGE_TYPES[path.split(".").pop()!.toLowerCase()]) ordered.push(path); };
  opf.querySelectorAll("spine > itemref").forEach(ref => {
    const entry = manifest.get(ref.getAttribute("idref") || "");
    if (!entry) return;
    if (entry.type.startsWith("image/")) { add(entry.href); return; }
    if (!files[entry.href]) return;
    const doc = parser.parseFromString(strFromU8(files[entry.href]), entry.type.includes("xml") ? "application/xhtml+xml" : "text/html");
    doc.querySelectorAll("img, image").forEach(el => {
      const src = el.getAttribute("src") || el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (src && !/^(data|https?):/i.test(src)) add(resolvePath(entry.href, src));
    });
  });
  // Fall back to manifest order for image-only packages with no XHTML pages.
  if (!ordered.length) manifest.forEach(entry => { if (entry.type.startsWith("image/")) add(entry.href); });
  if (!ordered.length) throw new Error("This EPUB has no page images. Comic EPUBs need illustrated pages.");

  const total = Math.min(ordered.length, MAX_PAGES);
  const images: string[] = [];
  for (let i = 0; i < total; i++) {
    const path = ordered[i];
    const blob = new Blob([files[path] as BlobPart], { type: IMAGE_TYPES[path.split(".").pop()!.toLowerCase()] });
    try {
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width * bitmap.height <= 40_000_000) images.push(toJpeg(bitmap, bitmap.width, bitmap.height));
      bitmap.close();
    } catch { /* skip unreadable images */ }
    onProgress?.(i + 1, total);
  }
  if (!images.length) throw new Error("None of the images in this EPUB could be read.");
  return { images, totalPages: ordered.length };
}

export async function importDocument(file: File, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Choose a file smaller than 80 MB.");
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return importPdf(file, onProgress);
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) return importEpub(file, onProgress);
  throw new Error("Choose a PDF or EPUB file.");
}
