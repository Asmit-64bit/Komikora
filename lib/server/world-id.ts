import "server-only";
// World ID 4 personhood. One verified human per account: the RP-scoped nullifier is
// stored as a salted hash and may be linked to only one account. Proofs and raw
// nullifiers are never stored, logged, or written on chain.
import { createHash, timingSafeEqual } from "node:crypto";
import { signRequest } from "@worldcoin/idkit-server";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { AppError, ensure, type Database } from "@/lib/store";
import type { User } from "@/lib/types";
import { NotConfiguredError, envValue } from "./env";

const REQUEST_TTL_SECONDS = 300;

export function worldIdConfig() {
  const appId = envValue("NEXT_PUBLIC_WORLD_APP_ID");
  const rpId = envValue("WORLD_RP_ID");
  const signingKey = envValue("WORLD_RP_SIGNING_KEY");
  const action = envValue("WORLD_ACTION") || "consentcraft-verify-account";
  const missing = [!appId && "NEXT_PUBLIC_WORLD_APP_ID", !rpId && "WORLD_RP_ID", !signingKey && "WORLD_RP_SIGNING_KEY"].filter(Boolean) as string[];
  if (missing.length) throw new NotConfiguredError("World ID", missing);
  if (!appId!.startsWith("app_")) throw new AppError("NEXT_PUBLIC_WORLD_APP_ID must start with app_.", 500);
  return {
    appId: appId as `app_${string}`, rpId: rpId!, action,
    signingKeyHex: signingKey!.replace(/^0x/, ""),
    environment: envValue("WORLD_ENVIRONMENT") || "production",
    verifyUrl: `${envValue("WORLD_VERIFY_BASE_URL") || "https://developer.worldcoin.org"}/api/v4/verify/${rpId}`,
  };
}

/** Starts a verification for the signed-in wallet. The nonce is single use and bound to this user. */
export function startVerification(db: Database, user: User) {
  const config = worldIdConfig();
  ensure(!user.worldIdVerifiedAt, "This account is already verified with World ID.", 409);
  const sig = signRequest({ signingKeyHex: config.signingKeyHex, action: config.action, ttl: REQUEST_TTL_SECONDS });
  const now = Date.now();
  db.worldIdRequests = (db.worldIdRequests ?? []).filter(r => r.expires > now && r.userId !== user.id);
  ensure(db.worldIdRequests.length < 1000, "Too many verification requests. Please try again later.", 429);
  db.worldIdRequests.push({ nonce: sig.nonce, userId: user.id, expires: sig.expiresAt * 1000 });
  return {
    app_id: config.appId,
    action: config.action,
    signal: user.address,
    environment: config.environment,
    rp_context: { rp_id: config.rpId, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
  };
}

type V4Result = {
  protocol_version?: unknown; nonce?: unknown; action?: unknown; environment?: unknown;
  responses?: { identifier?: unknown; signal_hash?: unknown; nullifier?: unknown; proof?: unknown }[];
};

function nullifierKey(nullifier: string, rpId: string) {
  const value = /^\d+$/.test(nullifier) ? BigInt(nullifier) : BigInt(nullifier.startsWith("0x") ? nullifier : `0x${nullifier}`);
  // Salted with the RP id so the stored value is useless outside this app.
  return createHash("sha256").update(`consentcraft:world-id:${rpId}:${value.toString(16)}`).digest("hex");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Verifies a World ID 4 proof with the Developer Portal and links it to the user.
 * The request nonce is consumed before the network call, so a proof cannot be replayed.
 */
export async function completeVerification(db: Database, user: User, raw: unknown, fetcher: typeof fetch = fetch) {
  const config = worldIdConfig();
  ensure(raw && typeof raw === "object" && !Array.isArray(raw), "Invalid World ID result.");
  const result = raw as V4Result;
  ensure(result.protocol_version === "4.0", "Use World App with World ID 4. Legacy proofs are not accepted.");
  ensure(typeof result.nonce === "string" && result.action === config.action, "This World ID proof is for a different request.");
  ensure(result.environment === config.environment, `This World ID proof is from the ${String(result.environment)} environment.`);
  const request = (db.worldIdRequests ?? []).find(r => same(r.nonce, result.nonce as string));
  db.worldIdRequests = (db.worldIdRequests ?? []).filter(r => r !== request && r.expires > Date.now());
  ensure(request && request.userId === user.id && request.expires > Date.now(), "This World ID request expired or was already used. Start again.", 401);
  ensure(Array.isArray(result.responses) && result.responses.length > 0, "The World ID proof is empty.");
  const signalHash = hashSignal(user.address).toLowerCase();
  for (const item of result.responses) {
    ensure(typeof item.nullifier === "string" && item.nullifier.length > 0, "The World ID proof has no nullifier.");
    ensure(typeof item.signal_hash === "string" && item.signal_hash.toLowerCase() === signalHash, "This World ID proof was made for a different wallet.");
  }

  const response = await fetcher(config.verifyUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new AppError("World ID verification is unreachable. Please try again.", 502); });
  const body = await response.json().catch(() => ({})) as { success?: boolean; code?: string; detail?: string };
  if (!response.ok || body.success !== true) {
    throw new AppError(`World ID rejected this proof${body.code ? ` (${body.code})` : ""}.`, 400);
  }

  const key = nullifierKey(result.responses[0].nullifier as string, config.rpId);
  db.worldIdNullifiers ??= {};
  const owner = db.worldIdNullifiers[key];
  ensure(!owner || owner === user.id, "This World ID is already linked to another ConsentCraft account.", 409);
  db.worldIdNullifiers[key] = user.id;
  const account = db.users.find(u => u.id === user.id)!;
  account.worldIdVerifiedAt = new Date().toISOString();
  account.worldIdEnvironment = config.environment;
  return { verifiedAt: account.worldIdVerifiedAt };
}
