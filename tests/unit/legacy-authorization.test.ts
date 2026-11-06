import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { NextRequest } from "next/server";
import type { Database } from "@/lib/store";
import { PERSONHOOD_CERTIFICATE_TYPES, marketDomain } from "@/lib/eip712";

const state = vi.hoisted(() => ({ db: {} as Database }));
vi.mock("@/lib/store", async original => ({
  ...await original<typeof import("@/lib/store")>(),
  database: async (work: (db: Database) => unknown) => work(state.db),
}));
import { authorizeLegacyPurchase } from "@/lib/server/legacy-authorization";
import { POST } from "@/app/api/market/authorization/route";

const key = `0x${"11".repeat(32)}` as const;
const wallet = privateKeyToAccount(key);
const contract = `0x${"22".repeat(20)}` as const;
beforeEach(() => {
  vi.stubEnv("QUOTE_SIGNER_PRIVATE_KEY", key);
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "31337");
  vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_ADDRESS", contract);
  vi.stubEnv("CHAIN_RPC_URL", "http://127.0.0.1:8545");
  vi.stubEnv("APP_ORIGIN", "https://comic.test");
  state.db = { users: [{ id: "reader", name: "Reader", color: "purple", address: wallet.address }], sessions: [{ token: "session", userId: "reader", auth: "wallet", expires: Date.now() + 60_000 }], projects: [], invitations: [] };
});
afterEach(() => vi.unstubAllEnvs());

describe("legacy wallet purchase authorization", () => {
  it("requires a live signed-wallet session", async () => {
    await expect(authorizeLegacyPurchase(undefined)).rejects.toThrow(/Sign in/);
    state.db.sessions[0].expires = Date.now() - 1;
    await expect(authorizeLegacyPurchase("session")).rejects.toThrow(/Sign in/);
  });
  it("signs a short-lived, deployment-bound certificate for a wallet-only account", async () => {
    const { certificate, signature } = await authorizeLegacyPurchase("session");
    expect(certificate.wallet).toBe(wallet.address);
    expect(certificate.action).toBe(1);
    expect(Number(certificate.expiresAt)).toBeGreaterThan(Date.now() / 1000 + 590);
    expect(Number(certificate.expiresAt)).toBeLessThan(Date.now() / 1000 + 601);
    expect(await verifyTypedData({ address: wallet.address, domain: marketDomain(31337, contract), types: PERSONHOOD_CERTIFICATE_TYPES, primaryType: "PersonhoodCertificate", message: certificate, signature })).toBe(true);
  });
  it("issues unique nonces for separate requests", async () => {
    const first = await authorizeLegacyPurchase("session");
    const second = await authorizeLegacyPurchase("session");
    expect(first.certificate.nonce).not.toBe(second.certificate.nonce);
  });
  it("rejects requests from another origin", async () => {
    const response = await POST(new NextRequest("https://comic.test/api/market/authorization", { method: "POST", headers: { Origin: "https://other.test", "Content-Type": "application/json", Cookie: "cc_session=session" }, body: JSON.stringify({ action: "purchase" }) }));
    expect(response.status).toBe(403);
  });
  it("uses the session wallet rather than a caller-supplied address", async () => {
    const response = await POST(new NextRequest("https://comic.test/api/market/authorization", { method: "POST", headers: { Origin: "https://comic.test", "Content-Type": "application/json", Cookie: "cc_session=session" }, body: JSON.stringify({ action: "purchase", address: contract }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).certificate.wallet).toBe(wallet.address);
  });
});
