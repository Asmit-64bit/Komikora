import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { keccak256 } from "viem";
import type { Panel } from "@/lib/types";

let content: typeof import("@/lib/server/content");
let panels: Panel[];

beforeAll(async () => {
  process.env.CONTENT_KEY_ENCRYPTION_KEY = `0x${"11".repeat(32)}`;
  content = await import("@/lib/server/content");
  const jpeg = async (r: number) => `data:image/jpeg;base64,${(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 90, b: 140 } } }).jpeg().toBuffer()).toString("base64")}`;
  panels = await Promise.all([10, 80, 160, 240].map(async (r, i) => ({ image: await jpeg(r), dialogue: `line ${i}`, alt: `alt ${i}` })));
});

describe("paid page encryption", () => {
  it("round-trips every page and caption, and the hash commits to the exact bytes", () => {
    const key = content.newContentKey();
    const bundle = content.buildBundle(panels, key);
    expect(bundle.manifestHash).toBe(keccak256(bundle.bytes));
    expect(bundle.pageCount).toBe(4);
    const pages = content.openBundle(bundle.bytes, bundle.manifestHash, key);
    expect(pages.map(p => p.dialogue)).toEqual(["line 0", "line 1", "line 2", "line 3"]);
    expect(`data:image/jpeg;base64,${pages[2].image}`).toBe(panels[2].image);
  });

  it("never stores plaintext images or captions in the uploaded bundle", () => {
    const bundle = content.buildBundle(panels, content.newContentKey());
    const text = bundle.bytes.toString("utf8");
    expect(text).not.toContain("line 0");
    expect(text).not.toContain(panels[0].image.split(",")[1].slice(0, 40));
  });

  it("rejects a bundle that does not match its on-chain fingerprint", () => {
    const key = content.newContentKey();
    const bundle = content.buildBundle(panels, key);
    const tampered = Buffer.from(bundle.bytes);
    tampered[tampered.length - 5] ^= 1;
    expect(() => content.openBundle(tampered, bundle.manifestHash, key)).toThrow(/fingerprint/);
  });

  it("rejects decryption with the wrong key", () => {
    const bundle = content.buildBundle(panels, content.newContentKey());
    expect(() => content.openBundle(bundle.bytes, bundle.manifestHash, content.newContentKey())).toThrow();
  });

  it("binds a wrapped content key to its project", () => {
    const key = content.newContentKey();
    const wrapped = content.wrapKey(key, "project-a");
    expect(content.unwrapKey(wrapped, "project-a").equals(key)).toBe(true);
    expect(() => content.unwrapKey(wrapped, "project-b")).toThrow(/content key/);
  });

  it("refuses to publish a panel without a saved JPEG", () => {
    expect(() => content.buildBundle([{ image: "", dialogue: "", alt: "" }], content.newContentKey())).toThrow(/needs a saved image/);
  });

  it("builds the preview manifest the indexer validates", () => {
    const preview = content.previewManifest({ title: "T", description: "D", language: "en", genre: "fantasy", previewImageTxId: "A".repeat(43) });
    expect(JSON.parse(preview.bytes.toString())).toEqual({ schema: "consentcraft.preview.v1", title: "T", description: "D", language: "en", genre: "fantasy", previewImages: [`ar://${"A".repeat(43)}`] });
    expect(preview.hash).toBe(keccak256(preview.bytes));
  });
});
