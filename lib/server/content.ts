import "server-only";
// Paid pages are encrypted before they leave the server. Arweave stores only
// ciphertext. The per-comic content key is itself encrypted ("wrapped") with the
// server's key-encryption key and is never sent to Arweave, Arkiv or the chain.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import sharp from "sharp";
import { keccak256, type Hex } from "viem";
import type { Panel } from "@/lib/types";
import { AppError, ensure } from "@/lib/store";
import { privateKey } from "./env";

export const BUNDLE_SCHEMA = "consentcraft.bundle.v1";
export const PREVIEW_SCHEMA = "consentcraft.preview.v1";

type BundlePage = { index: number; iv: string; ciphertext: string; plaintextHash: Hex };
export type Bundle = { schema: typeof BUNDLE_SCHEMA; cipher: "AES-256-GCM"; pageCount: number; pages: BundlePage[] };
export type PagePlaintext = { mime: "image/jpeg"; image: string; dialogue: string; alt: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const aad = (index: number) => Buffer.from(`${BUNDLE_SCHEMA}:page:${index}`);

function seal(key: Buffer, plaintext: Buffer, associated: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(associated);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, body };
}

function open(key: Buffer, iv: Buffer, sealed: Buffer, associated: Buffer) {
  ensure(iv.length === 12 && sealed.length > 16, "Corrupt encrypted data.", 500);
  const decipher = createDecipheriv("aes-256-gcm", key, iv).setAAD(associated);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

function kek() {
  return Buffer.from(privateKey("CONTENT_KEY_ENCRYPTION_KEY", "Paid page encryption").slice(2), "hex");
}

export function newContentKey() { return randomBytes(32); }

export function wrapKey(contentKey: Buffer, projectId: string) {
  const { iv, body } = seal(kek(), contentKey, Buffer.from(`consentcraft:key:${projectId}`));
  return `${iv.toString("base64")}.${body.toString("base64")}`;
}

export function unwrapKey(wrapped: string, projectId: string) {
  const [iv, body] = wrapped.split(".");
  try { return open(kek(), Buffer.from(iv, "base64"), Buffer.from(body, "base64"), Buffer.from(`consentcraft:key:${projectId}`)); }
  catch { throw new AppError("The content key could not be unlocked. Check CONTENT_KEY_ENCRYPTION_KEY.", 500); }
}

function imageBytes(panel: Panel, index: number) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(panel.image);
  ensure(match, `Panel ${index + 1} needs a saved image before publishing.`);
  return Buffer.from(match[1], "base64");
}

/** Encrypts every panel (image and captions). Returns the exact bytes to upload and their hash. */
export function buildBundle(panels: Panel[], contentKey: Buffer) {
  ensure(panels.length > 0, "A comic needs at least one panel.");
  const pages: BundlePage[] = panels.map((panel, index) => {
    const plaintext: PagePlaintext = { mime: "image/jpeg", image: b64(imageBytes(panel, index)), dialogue: panel.dialogue, alt: panel.alt };
    const bytes = Buffer.from(JSON.stringify(plaintext));
    const { iv, body } = seal(contentKey, bytes, aad(index));
    return { index, iv: iv.toString("base64"), ciphertext: body.toString("base64"), plaintextHash: keccak256(bytes) };
  });
  const bundle: Bundle = { schema: BUNDLE_SCHEMA, cipher: "AES-256-GCM", pageCount: pages.length, pages };
  const bytes = Buffer.from(JSON.stringify(bundle));
  return { bytes, manifestHash: keccak256(bytes), pageCount: pages.length };
}

/** Verifies the bundle against its on-chain hash, then decrypts and checks every page. */
export function openBundle(bytes: Uint8Array, expectedHash: Hex, contentKey: Buffer): PagePlaintext[] {
  ensure(keccak256(bytes).toLowerCase() === expectedHash.toLowerCase(), "The stored comic does not match its on-chain fingerprint.", 502);
  const bundle = JSON.parse(Buffer.from(bytes).toString("utf8")) as Bundle;
  ensure(bundle.schema === BUNDLE_SCHEMA && Array.isArray(bundle.pages) && bundle.pages.length === bundle.pageCount, "Unsupported comic bundle.", 502);
  return bundle.pages.map((page, i) => {
    ensure(page.index === i, "Comic pages are out of order.", 502);
    const plain = open(contentKey, Buffer.from(page.iv, "base64"), Buffer.from(page.ciphertext, "base64"), aad(i));
    ensure(keccak256(plain).toLowerCase() === page.plaintextHash.toLowerCase(), `Page ${i + 1} failed its integrity check.`, 502);
    return JSON.parse(plain.toString("utf8")) as PagePlaintext;
  });
}

/** A small public preview of the cover. Only this and the listing text are unencrypted. */
export async function previewImage(panels: Panel[]) {
  return sharp(imageBytes(panels[0], 0)).resize({ width: 480, height: 480, fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
}

export function previewManifest(fields: { title: string; description: string; language: string; genre: string; previewImageTxId: string }) {
  const manifest = {
    schema: PREVIEW_SCHEMA, title: fields.title, description: fields.description,
    language: fields.language, genre: fields.genre, previewImages: [`ar://${fields.previewImageTxId}`],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { bytes, hash: keccak256(bytes) };
}

