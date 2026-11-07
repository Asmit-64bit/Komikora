import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Database } from "@/lib/store";
import sharp from "sharp";
const state = vi.hoisted(() => ({ db: {} as Database, bytes: new Map<string, Uint8Array>(), flags: false, fail: false, reads: [] as boolean[], manifest: "0x" as `0x${string}`, reviewer: "", counter: 0, blockOffset: 1000, similarity: 0 }));
vi.mock("@/lib/store", async original => {
  const actual = await original<typeof import("@/lib/store")>();
  return { ...actual, database: async (work: (db: Database) => unknown) => work(state.db) };
});
vi.mock("@/lib/server/arweave", () => ({
  upload: async (bytes: Uint8Array) => { const id = String(++state.counter).padStart(43, "a"); state.bytes.set(id, bytes); return id; },
  fetchVerified: async (id: string) => { const bytes = state.bytes.get(id); if (!bytes) throw new Error("Unavailable storage"); return bytes; },
  gatewayUrl: (id: string) => `https://example.test/${id}`,
}));
vi.mock("@/lib/server/zg", () => ({ SCREENING_PROMPT_VERSION: "test-v1", screenWith0G: async () => {
  if (state.fail) throw new Error("Inference unavailable");
  return { score: 7500, flagged: state.flags, reasons: ["Test review"], model: "test-model", provider: "test-provider", teeVerified: false, at: new Date().toISOString() };
} }));
vi.mock("@/lib/server/originality", () => ({ assessOriginality: async () => ({ crux: "A test story", maxSimilarity: state.similarity, comparedComicCount: "0", model: "test", requestId: "test", at: new Date().toISOString(), comparisons: [] }) }));
vi.mock("@/lib/server/nft-chain", () => {
  const cfg = () => ({ address: `0x${"12".repeat(20)}`, chainId: 31337, confirmations: 0, blockNumber: BigInt(1), client: { readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "comicCount") return BigInt(0);
    if (functionName === "reviewer") return state.reviewer;
    if (functionName === "canRead") return state.reads.shift() ?? false;
    if (functionName === "tokenComic") return BigInt(1);
    if (functionName === "comicForKey") return BigInt(0);
    if (functionName === "comics") return [state.reviewer, state.db.projects[0].edition!.key, state.manifest];
  }, getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) + state.blockOffset) }) } });
  return { nftConfig: cfg, confirmedNFT: async () => cfg() };
});
import { prepareEdition, readEdition, reopenEdition } from "@/lib/server/editions";
describe("edition publishing and ownership-gated pages", () => {
  beforeEach(async () => {
    const key = `0x${"11".repeat(32)}` as const; state.reviewer = privateKeyToAccount(key).address;
    process.env.EDITION_REVIEWER_PRIVATE_KEY = key; process.env.CONTENT_KEY_ENCRYPTION_KEY = key;
    state.flags = false; state.fail = false; state.reads = []; state.bytes.clear(); state.counter = 0; state.blockOffset = 1000; state.similarity = 0;
    const pixels = Buffer.from(Array.from({ length: 8 * 8 * 3 }, (_, i) => Math.floor(i / 3) % 2 ? 255 : 0));
    const image = `data:image/jpeg;base64,${(await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } }).jpeg().toBuffer()).toString("base64")}`;
    state.db = { users: [{ id: "owner", address: state.reviewer as `0x${string}`, name: "Creator", color: "purple" }], sessions: [{ token: "session", userId: "owner", expires: Date.now() + 100000, auth: "wallet" }], invitations: [], projects: [{ id: "project", ownerId: "owner", title: "Test comic", description: "", genre: "Fantasy", theme: "", terms: "Reading license", revision: 1, version: 0, state: "draft", rosterFrozen: false, approvals: [], events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), panels: Array.from({ length: 4 }, () => ({ image, dialogue: "Secret dialogue", alt: "Comic panel" })), members: [{ userId: "owner", address: state.reviewer as `0x${string}`, name: "Creator", role: "Artist", share: 10000 }] }] };
  });
  const submit = () => prepareEdition("session", { id: "project", revision: 1, supply: 2, rights: true });
  it("rejects blank pages before originality review or any upload", async () => {
    const blank = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).jpeg().toBuffer();
    state.db.projects[0].panels[1].image = `data:image/jpeg;base64,${blank.toString("base64")}`;
    await expect(submit()).rejects.toThrow(/Page 2 is blank/);
    expect(state.counter).toBe(0);
    expect(state.db.projects[0].edition).toBeUndefined();
    expect(state.db.projects[0].originality).toBeUndefined();
  });
  it("blocks similarity above 85 before any upload and permits 85", async () => {
    state.similarity = 86;
    await expect(submit()).rejects.toThrow(/more than 85%/);
    expect(state.counter).toBe(0);
    expect(state.db.projects[0].originality?.maxSimilarity).toBe(86);
    state.similarity = 85;
    await expect(submit()).resolves.toBeDefined();
  });
  it("requires signature login, rights and a valid supply", async () => {
    await expect(prepareEdition(undefined, { id: "project" })).rejects.toThrow(/Sign in/);
    await expect(prepareEdition("session", { id: "project", revision: 1, supply: 2 })).rejects.toThrow(/permission/);
    await expect(prepareEdition("session", { id: "project", revision: 1, supply: 26, rights: true })).rejects.toThrow(/1–25/);
  });
  it("encrypts pages, signs approved content and freezes supply and license", async () => {
    const result = await submit(); const e = state.db.projects[0].edition!;
    if (!("permit" in result)) throw new Error("Expected a mint permit");
    expect(result.permit.supply).toBe(2); expect(result.signature).toMatch(/^0x/); expect(e.status).toBe("approved"); expect(state.db.projects[0].state).toBe("review");
    expect(Buffer.from(state.bytes.get(e.bundleTxId)!).toString()).not.toContain("Secret dialogue");
    expect(JSON.parse(Buffer.from(state.bytes.get(e.uri!.slice(5))!).toString()).license).toBe("Reading license");
  });
  it("never issues a permit on an inference failure, and retries existing uploads", async () => {
    state.fail = true; await expect(submit()).rejects.toThrow(/Inference unavailable/);
    const old = state.db.projects[0].edition!.bundleTxId; expect(state.db.projects[0].edition!.status).toBe("uploaded");
    state.fail = false; await submit(); expect(state.db.projects[0].edition!.bundleTxId).toBe(old);
  });
  it("routes flags to human review, lets the author reopen unminted work", async () => {
    state.flags = true; await expect(submit()).rejects.toThrow(/human review/);
    expect(state.db.projects[0].edition!.status).toBe("flagged");
    await reopenEdition("session", "project"); expect(state.db.projects[0].state).toBe("draft"); expect(state.db.projects[0].edition).toBeUndefined();
  });
  it("checks ownership before decrypting and rechecks before returning pages", async () => {
    await submit(); state.manifest = state.db.projects[0].edition!.manifestHash;
    state.reads = [false]; await expect(readEdition("session", "1")).rejects.toThrow(/current edition owner/);
    state.reads = [true, false]; await expect(readEdition("session", "1")).rejects.toThrow(/Ownership changed/);
    state.reads = [true, true]; const result = await readEdition("session", "1"); expect(result.pages).toHaveLength(4); expect(result.pages[0].dialogue).toBe("Secret dialogue");
  });
  it("does not let an unauthorized preparation overwrite an existing publication", async () => {
    await submit(); state.db.projects[0].edition!.error = "Creator-only status";
    await expect(prepareEdition(undefined, { id: "project" })).rejects.toThrow(/Sign in/);
    expect(state.db.projects[0].edition!.error).toBe("Creator-only status");
  });
  it("enforces the wallet account quota across reopened and separate submissions", async () => {
    state.db.editionSubmissions = Array.from({ length: 5 }, () => ({ userId: "owner", at: Date.now() }));
    await expect(submit()).rejects.toThrow(/five submissions/);
    expect(state.db.projects[0].edition).toBeUndefined();
  });
  it("waits for outstanding mint permits to expire before reopening", async () => {
    await submit(); state.blockOffset = 0;
    await expect(reopenEdition("session", "project")).rejects.toThrow(/permit is still valid/);
    expect(state.db.projects[0].state).toBe("review");
  });
  it("allows a wallet-only creator to mint after review with a short-lived permit", async () => {
    const review = await prepareEdition("session", { id: "project", revision: 1, supply: 2, rights: true, reviewOnly: true });
    expect(review).toEqual({ reviewReady: true });
    expect(state.db.projects[0].edition!.permitExpiresAt).toBeUndefined();
    const prepared = await submit();
    if (!("permit" in prepared)) throw new Error("Expected a mint permit");
    const blockTime = Math.floor(Date.now() / 1000) + state.blockOffset;
    expect(Number(prepared.permit.deadline)).toBeGreaterThanOrEqual(blockTime + 599);
    expect(Number(prepared.permit.deadline)).toBeLessThanOrEqual(blockTime + 601);
    expect(state.db.projects[0].edition!.permitExpiresAt).toBe(Number(prepared.permit.deadline));
    const metadata = JSON.parse(Buffer.from(state.bytes.get(prepared.uri.slice(5))!).toString());
    expect(metadata.creator).toBe(state.reviewer);
    expect(metadata).not.toHaveProperty("creatorVerified");
  });
  it("allows reopening only after the last issued permit expires", async () => {
    await submit(); state.blockOffset += 601;
    await reopenEdition("session", "project");
    expect(state.db.projects[0].edition).toBeUndefined();
    expect(state.db.projects[0].state).toBe("draft");
  });
});
