import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { Database } from "@/lib/store";
const state = vi.hoisted(() => ({ db: {} as Database, token: "", jwk: {} as Record<string, unknown> }));
vi.mock("@/lib/store", async original => ({ ...await original<typeof import("@/lib/store")>(), database: async (work: (db: Database) => unknown) => work(state.db) }));
import { startPublicationApproval, finishPublicationApproval, decidePublicationApproval, readPublicationApproval, reservePublicationApproval } from "@/lib/server/agent-pass";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const issuer = "https://auth.world.org";
beforeAll(async () => { keys = await generateKeyPair("RS256"); state.jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" }; });
beforeEach(() => {
  process.env.WORLD_AGENTPASS_CLIENT_ID = "fixture-client"; process.env.WORLD_AGENTPASS_CLIENT_SECRET = "fixture-secret"; process.env.APP_ORIGIN = "https://comic.test";
  process.env.WORLD_AGENTPASS_ISSUER = issuer; process.env.WORLD_AGENTPASS_ACR = "https://world.org/oidc/acr/orb";
  delete process.env.WORLD_AGENTPASS_AUTH_METHOD; delete process.env.WORLD_AGENTPASS_REDIRECT_URI;
  state.db = { users: [{ id: "owner", address: `0x${"11".repeat(20)}`, name: "Creator", color: "purple", worldIdVerifiedAt: new Date().toISOString() }], sessions: [{ token: "session", userId: "owner", expires: Date.now() + 1000000, auth: "wallet" }], invitations: [], projects: [{ id: "project", ownerId: "owner", title: "A comic", description: "", genre: "Fantasy", theme: "", terms: "Reading license", panels: [], members: [], state: "review", revision: 2, version: 0, approvals: [], rosterFrozen: true, createdAt: "", updatedAt: "", events: [], edition: { key: `0x${"22".repeat(32)}`, manifestHash: `0x${"33".repeat(32)}`, bundleTxId: "b".repeat(43), coverTxId: "c".repeat(43), supply: 1, license: "Read while owned", rightsAt: "", status: "approved", chainId: 31337, contract: `0x${"44".repeat(20)}`, reserveWei: "100", auctionDuration: 3600 } }] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer, authorization_endpoint: issuer + "/api/v1/authorize", token_endpoint: issuer + "/api/v1/token", jwks_uri: issuer + "/.well-known/jwks.json" });
    if (url.endsWith("jwks.json")) return Response.json({ keys: [state.jwk] });
    if (url.endsWith("/token")) return Response.json({ id_token: state.token });
    throw new Error("Unexpected request");
  });
});
async function request() { return startPublicationApproval("session", "project", true); }
async function authenticate(r: Awaited<ReturnType<typeof request>>, overrides: Record<string, unknown> = {}) {
  const url = new URL(r.url);
  state.token = await new SignJWT({ nonce: url.searchParams.get("nonce"), acr: "https://world.org/oidc/acr/orb", amr: ["world_id"], auth_time: Math.floor(Date.now() / 1000), ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience("fixture-client").setSubject("human-one").setIssuedAt().setExpirationTime("10m").sign(keys.privateKey);
  return finishPublicationApproval(new URLSearchParams({ state: url.searchParams.get("state")!, iss: issuer, code: "single-use-code" }), r.binding);
}
describe("World ID publication approval", () => {
  it("onboards an unverified creator separately from publication consent", async () => {
    state.db.users[0].worldIdVerifiedAt = undefined;
    const r = await startPublicationApproval("session", undefined, true, true); await authenticate(r);
    expect(state.db.users[0].worldIdVerifiedAt).toBeUndefined();
    await decidePublicationApproval("session", r.id, true);
    expect(state.db.users[0].worldIdVerifiedAt).toBeTruthy(); expect(state.db.users[0].worldIdEnvironment).toBe("production");
    expect(state.db.projects[0].edition!.approvalId).toBeUndefined();
    await expect(reservePublicationApproval("session", state.db.projects[0])).rejects.toThrow();
  });
  it("requires an initiating session and explicit first-time identity enrollment", async () => {
    await expect(startPublicationApproval(undefined, "project", true)).rejects.toThrow(/Sign in/);
    await expect(startPublicationApproval("session", "project", false)).rejects.toThrow(/linking/);
  });
  it("requests fresh authentication with state, nonce and S256 PKCE", async () => {
    const r = await request(); const url = new URL(r.url);
    expect(url.searchParams.get("max_age")).toBe("0"); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy(); expect(url.searchParams.get("nonce")).toBeTruthy();
  });
  it("validates a signed token but waits for explicit approval before authorizing minting", async () => {
    const r = await request(); await authenticate(r);
    expect((await readPublicationApproval("session", r.id)).status).toBe("authenticated");
    await expect(reservePublicationApproval("session", state.db.projects[0])).rejects.toThrow(/not approved/);
    await decidePublicationApproval("session", r.id, true);
    const expiry = await reservePublicationApproval("session", state.db.projects[0]);
    expect(state.db.publicationApprovals![0].status).toBe("used");
    expect(await reservePublicationApproval("session", state.db.projects[0])).toBe(expiry);
    const publicResult = JSON.stringify(await readPublicationApproval("session", r.id)); expect(publicResult).not.toContain(state.token); expect(publicResult).not.toContain("verifier");
  });
  it("blocks denied approvals and replayed callbacks", async () => {
    const r = await request(); await authenticate(r); await decidePublicationApproval("session", r.id, false);
    await expect(reservePublicationApproval("session", state.db.projects[0])).rejects.toThrow(/not approved/);
    await expect(authenticate(r)).rejects.toThrow(/already used/);
  });
  it("rejects nonce, freshness and assurance mismatches", async () => {
    for (const overrides of [{ nonce: "wrong" }, { auth_time: 1 }, { acr: "unverified" }]) {
      const r = await request(); await authenticate(r, overrides);
      expect((await readPublicationApproval("session", r.id)).status).toBe("failed");
      await expect(reservePublicationApproval("session", state.db.projects[0])).rejects.toThrow(/not approved/);
    }
  });
  it("rejects changed terms, expired requests and a mismatched browser", async () => {
    const r = await request(); const url = new URL(r.url);
    await expect(finishPublicationApproval(new URLSearchParams({ state: url.searchParams.get("state")!, iss: issuer, code: "code" }), "wrong-browser")).rejects.toThrow(/browser/);
    await authenticate(r); state.db.projects[0].edition!.reserveWei = "200";
    await expect(decidePublicationApproval("session", r.id, true)).rejects.toThrow(/terms changed/);
    const next = await request(); state.db.publicationApprovals!.find(a => a.id === next.id)!.expiresAt = Date.now() - 1;
    await expect(authenticate(next)).rejects.toThrow(/expired/);
  });
  it("keeps publication blocked on a provider-denied path", async () => {
    const r = await request(); const url = new URL(r.url);
    await finishPublicationApproval(new URLSearchParams({ state: url.searchParams.get("state")!, iss: issuer, error: "access_denied" }), r.binding);
    expect((await readPublicationApproval("session", r.id)).status).toBe("failed");
  });
});
