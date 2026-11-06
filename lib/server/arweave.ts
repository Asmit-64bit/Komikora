import "server-only";
// Arweave storage through an ar.io Turbo bundler. Every upload is read back from a
// gateway and re-hashed before the server signs anything that points at it.
// Defaults target the ar.io testnet sandbox (free up to 5 MiB per item); set the
// URLs to the production Turbo services for mainnet Arweave.
import { keccak256, type Hex } from "viem";
import { isArweaveTxId } from "@/contracts/lib/arweave-tx-id";
import { AppError, ensure } from "@/lib/store";
import { envValue, privateKey } from "./env";

const MAX_DOWNLOAD = 12 * 1024 * 1024;

function arweaveConfig() {
  return {
    uploadUrl: envValue("ARWEAVE_UPLOAD_URL") || "https://upload.services.ar-io.dev",
    paymentUrl: envValue("ARWEAVE_PAYMENT_URL") || "https://payment.services.ar-io.dev",
    gateway: (envValue("ARWEAVE_GATEWAY") || "https://ar-io.dev").replace(/\/$/, ""),
  };
}

let turboPromise: Promise<Awaited<ReturnType<typeof import("@ardrive/turbo-sdk").TurboFactory.authenticated>>> | undefined;
async function turbo() {
  const key = privateKey("ARWEAVE_UPLOAD_PRIVATE_KEY", "Arweave uploads");
  const cfg = arweaveConfig();
  turboPromise ??= import("@ardrive/turbo-sdk").then(({ TurboFactory }) => TurboFactory.authenticated({
    privateKey: key, token: "ethereum",
    uploadServiceConfig: { url: cfg.uploadUrl }, paymentServiceConfig: { url: cfg.paymentUrl },
  })).catch(error => { turboPromise = undefined; throw error; });
  return turboPromise;
}

export function gatewayUrl(txId: string) {
  return `${arweaveConfig().gateway}/raw/${txId}`;
}

async function download(txId: string) {
  const response = await fetch(gatewayUrl(txId), { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!response.ok) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  ensure(bytes.length <= MAX_DOWNLOAD, "Arweave item is larger than expected.", 502);
  return bytes;
}

/** Reads an item from the gateway and checks it against the expected keccak256 hash. */
export async function fetchVerified(txId: string, expected: Hex, { attempts = 6, delayMs = 3000 } = {}) {
  ensure(isArweaveTxId(txId), "Invalid Arweave id.", 400);
  for (let i = 0; i < attempts; i++) {
    const bytes = await download(txId).catch(() => undefined);
    if (bytes) {
      ensure(keccak256(bytes).toLowerCase() === expected.toLowerCase(), "Arweave data does not match its fingerprint.", 502);
      return bytes;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  throw new AppError("The Arweave gateway does not serve this item yet. Try again shortly.", 503);
}

/** Uploads bytes and returns the Arweave id. Callers verify with fetchVerified before relying on it. */
export async function upload(bytes: Uint8Array, contentType: string, tags: { name: string; value: string }[] = []) {
  const client = await turbo();
  const result = await client.upload({
    data: Buffer.from(bytes),
    dataItemOpts: { tags: [{ name: "Content-Type", value: contentType }, ...tags] },
  }).catch(error => { throw new AppError(`Arweave upload failed: ${(error as Error).message}`, 502); });
  ensure(isArweaveTxId(result.id), "The bundler returned an invalid Arweave id.", 502);
  return result.id;
}
