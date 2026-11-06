/**
 * Loads public display metadata from the Arweave preview manifest. The bytes are hashed and
 * compared with the on-chain previewManifestHash BEFORE they are parsed; unverified data is never used.
 */
import { keccak256, type Hex } from "viem";
import { z } from "zod";

import type { MetadataCacheEntry, PreviewMetadata } from "./types.ts";

/** Arkiv `str` attributes hold at most 128 bytes. */
const MAX_STR_BYTES = 128;
const AR_REF = /^ar:\/\/[A-Za-z0-9_-]{43}$/;

export interface ManifestFetcher {
  /** Raw bytes stored under an Arweave transaction ID. */
  fetch(arweaveTxId: string): Promise<Uint8Array>;
}

export class ManifestTooLargeError extends Error {}

/** Fetches from an Arweave gateway (default https://arweave.net). */
export function gatewayFetcher(gateway: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): ManifestFetcher {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return {
    async fetch(txId) {
      const res = await fetch(`${gateway.replace(/\/$/, "")}/${txId}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`Gateway returned HTTP ${res.status} for ${txId}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new ManifestTooLargeError(`Manifest ${txId} is ${declared} bytes`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new ManifestTooLargeError(`Manifest ${txId} is ${bytes.length} bytes`);
      return bytes;
    },
  };
}

/** Public fields the indexer reads. Unknown fields are ignored; never index anything else. */
const PreviewManifest = z.object({
  schema: z.literal("consentcraft.preview.v1"),
  title: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(35),
  genre: z.string().trim().min(1).max(64),
  previewImages: z.array(z.string()).max(32).default([]),
});

export type MetadataCheck = { now: Date; retryMs: number; maxAttempts: number; previous?: MetadataCacheEntry };

export async function loadPreviewMetadata(
  fetcher: ManifestFetcher,
  arweaveTxId: string,
  expectedHash: Hex,
  check: MetadataCheck,
): Promise<MetadataCacheEntry> {
  const attempts = (check.previous?.status === "unavailable" ? check.previous.attempts : 0) + 1;
  const unavailable = (reason: "hash_mismatch" | "fetch_failed" | "invalid_manifest" | "too_large", retryable: boolean) => ({
    status: "unavailable" as const,
    reason,
    retryable: retryable && attempts < check.maxAttempts,
    attempts,
    nextAttemptAt: new Date(check.now.getTime() + check.retryMs * 2 ** (attempts - 1)).toISOString(),
    checkedAt: check.now.toISOString(),
  });

  let bytes: Uint8Array;
  try {
    bytes = await fetcher.fetch(arweaveTxId);
  } catch (err) {
    return unavailable(err instanceof ManifestTooLargeError ? "too_large" : "fetch_failed", !(err instanceof ManifestTooLargeError));
  }
  // Arweave data is immutable, so a mismatch is permanent for these bytes. It is not retried.
  if (keccak256(bytes).toLowerCase() !== expectedHash.toLowerCase()) return unavailable("hash_mismatch", false);

  let parsed: z.infer<typeof PreviewManifest>;
  try {
    parsed = PreviewManifest.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return unavailable("invalid_manifest", false);
  }

  const { text: title, truncated } = truncateUtf8(parsed.title, MAX_STR_BYTES);
  const metadata: PreviewMetadata = {
    title,
    titleTruncated: truncated,
    genre: parsed.genre.toLowerCase(),
    language: parsed.language.toLowerCase(),
  };
  const ref = parsed.previewImages.find((r) => AR_REF.test(r));
  if (ref) metadata.previewRef = ref;
  return { status: "verified", metadata, checkedAt: check.now.toISOString() };
}

/** Truncates to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return { text, truncated: false };
  let out = "";
  for (const ch of text) {
    if (enc.encode(out + ch + "…").length > maxBytes) break;
    out += ch;
  }
  return { text: `${out}…`, truncated: true };
}

/** Whether a cached result should be fetched again now. */
export function needsMetadataFetch(entry: MetadataCacheEntry | undefined, now: Date): boolean {
  if (!entry) return true;
  if (entry.status === "verified") return false;
  return entry.retryable && new Date(entry.nextAttemptAt) <= now;
}
