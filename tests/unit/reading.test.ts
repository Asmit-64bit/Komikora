import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, verifyTypedData } from "viem";
import sharp from "sharp";
import type { Database } from "@/lib/store";
import type { Project } from "@/lib/types";
import { readingPermitTypes } from "@/lib/reading-permit";
const state = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown>, blobs: new Map<string, Uint8Array>(), uploads: 0, reviews: 0, fail: false, flagged: false, reviewer: "", revoked: new Set<string>(), canRead: new Set<string>(), published: false, hold: undefined as undefined | Promise<void>, similarity: 0, catalogue: 0, scans: 0 }));
vi.mock("@/lib/server/originality", async original => {
  const actual = await original<typeof import("@/lib/server/originality")>();
  const { ORIGINALITY_VERSION } = await import("@/lib/originality");
  return { ...actual,
    assessOriginality: async (p: Project) => {
      state.scans++; const r = state.db.projects.find(x => x.id === p.id)!.reading!;
      const result = { version: ORIGINALITY_VERSION, contentHash: r.contentHash, catalogueHash: keccak256(toHex(String(state.catalogue))), crux: "Private story synopsis", maxSimilarity: state.similarity, comparedComicCount: String(state.catalogue), model: "fixture", requestId: `scan-${state.catalogue}`, comparisonRequestIds: [], at: "2026-11-07T00:00:00.000Z", comparisons: [] };
      r.originality = result; return result;
    },
    assertOriginalityCurrent: async (result?: { catalogueHash: string }) => { if (result?.catalogueHash !== keccak256(toHex(String(state.catalogue)))) throw new Error("Catalogue changed"); },
  };
});
vi.mock("@/lib/store", async original => ({ ...await original<typeof import("@/lib/store")>(), database: async (work: (db: Database) => unknown) => { const next = state.queue.catch(() => {}).then(() => work(state.db)); state.queue = next; return next; } }));
vi.mock("@/lib/server/arweave", () => ({
  upload: async (bytes: Uint8Array) => { const key = String(++state.uploads).padStart(43, "a"); state.blobs.set(key, bytes); return key; },
  fetchVerified: async (key: string) => { const bytes = state.blobs.get(key); if (!bytes) throw new Error("Unavailable storage"); return bytes; },
  gatewayUrl: (key: string) => `https://example.test/${key}`,
}));
vi.mock("@/lib/server/zg", () => ({ SCREENING_PROMPT_VERSION: "test-v1", screenWith0G: async () => { state.reviews++; if (state.hold) await state.hold; if (state.fail) throw new Error("Inference unavailable"); return { score: 8000, flagged: state.flagged, reasons: ["Fixture"], model: "fixture", provider: "fixture", teeVerified: false, at: new Date().toISOString() }; } }));
vi.mock("@/lib/server/reading-chain", () => {
  const cfg = () => ({ address: `0x${"12".repeat(20)}`, chainId: 31337, confirmations: 0, blockNumber: BigInt(42), client: {
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    readContract: async ({ functionName, args }: { functionName: string; args?: string[] }) => {
      if (functionName === "revokedApprovals") return state.revoked.has(args![0].toLowerCase());
      if (functionName === "reviewer") return state.reviewer;
      if (functionName === "canRead") return state.canRead.has(args![1].toLowerCase());
      if (functionName === "comicForKey") return BigInt(state.published ? 1 : 0);
      if (functionName === "comics") { const r = state.db.projects[0].reading!; return [state.db.users[0].address, r.key, r.contentHash, r.manifestHash, r.metadataHash, r.licenseHash, r.contributorsHash, BigInt(r.priceWei), r.uri, BigInt(2)]; }
      throw new Error(`Unexpected contract read ${functionName}`);
    },
  } }); return { readingConfig: cfg, confirmedReading: async () => cfg() };
});
import { startTeamReview, teamApproval, curateReading, prepareReading, reopenReading, confirmReading, readComic } from "@/lib/server/reading";
const author = privateKeyToAccount(generatePrivateKey()), collaborator = privateKeyToAccount(generatePrivateKey()), outsider = privateKeyToAccount(generatePrivateKey());
const reviewerKey = generatePrivateKey(); const reviewer = privateKeyToAccount(reviewerKey);
const project = () => state.db.projects[0];
beforeEach(async () => {
  vi.stubEnv("EDITION_REVIEWER_PRIVATE_KEY", reviewerKey); vi.stubEnv("CONTENT_KEY_ENCRYPTION_KEY", `0x${"44".repeat(32)}`);
  state.queue = Promise.resolve(); state.blobs.clear(); state.uploads = 0; state.reviews = 0; state.fail = false; state.flagged = false; state.hold = undefined; state.revoked.clear(); state.canRead.clear(); state.published = false; state.reviewer = reviewer.address; state.similarity = 0; state.catalogue = 0; state.scans = 0;
  const pixels = Buffer.from(Array.from({ length: 16 * 16 * 3 }, (_, i) => Math.floor(i / 3) % 2 ? 255 : 0));
  const image = `data:image/jpeg;base64,${(await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).jpeg().toBuffer()).toString("base64")}`;
  const p: Project = { id: "comic", title: "Shared story", description: "Fixture", genre: "Original", theme: "", ownerId: "author", members: [{ userId: "author", name: "Author", address: author.address, role: "Writer", share: 6000 }, { userId: "collaborator", name: "Collaborator", address: collaborator.address, role: "Artist", share: 4000 }], panels: [{ image, dialogue: "Hello", alt: "Fixture" }], state: "draft", revision: 1, version: 0, approvals: [], terms: "Read with your purchased wallet access.", rosterFrozen: false, priceWei: "1000", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  state.db = { users: [{ id: "author", name: "Author", color: "purple", address: author.address }, { id: "collaborator", name: "Collaborator", color: "purple", address: collaborator.address }, { id: "outsider", name: "Outsider", color: "purple", address: outsider.address }], sessions: ["author", "collaborator", "outsider"].map(userId => ({ token: userId, userId, expires: Date.now() + 86400000, auth: "wallet" })), projects: [p], invitations: [] };
});
afterEach(() => vi.unstubAllEnvs());
async function approve(token: "author" | "collaborator", wallet = token === "author" ? author : collaborator) {
  const payload = await teamApproval(token, { id: "comic" }); if (!("domain" in payload)) throw new Error("Approval payload unavailable"); const signature = await wallet.signTypedData(payload);
  await teamApproval(token, { id: "comic", rights: true, signature }, true); return signature;
}
async function allAgree() { await startTeamReview("author", { id: "comic", revision: 1 }); await approve("author"); await approve("collaborator"); }
describe("collaborator publication approvals", () => {
  it("requires owner, saved content, fixed price and resolved invitations before freezing", async () => {
    await expect(startTeamReview("collaborator", { id: "comic", revision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(startTeamReview("author", { id: "comic", revision: 0 })).rejects.toThrow(/Save your latest/);
    project().priceWei = "0"; await expect(startTeamReview("author", { id: "comic", revision: 1 })).rejects.toThrow(/positive fixed/); project().priceWei = "1000";
    state.db.invitations.push({ id: "invite", projectId: "comic", address: outsider.address, expiresAt: new Date(Date.now() + 60000).toISOString(), accepted: false });
    await expect(startTeamReview("author", { id: "comic", revision: 1 })).rejects.toThrow(/pending invitations/);
    state.db.invitations = []; await startTeamReview("author", { id: "comic", revision: 1 }); expect(project().state).toBe("review"); expect(project().approvals).toEqual([]);
  });
  it("rejects another wallet's signature and prevents the owner skipping a collaborator", async () => {
    await startTeamReview("author", { id: "comic", revision: 1 }); await expect(approve("collaborator", outsider)).rejects.toMatchObject({ status: 401 });
    await approve("author"); await expect(curateReading("author", "comic")).rejects.toThrow(/Every collaborator/); expect(state.uploads).toBe(0); expect(state.reviews).toBe(0);
    await approve("collaborator"); await curateReading("author", "comic"); expect(project().reading?.status).toBe("approved"); expect(state.reviews).toBe(1);
  });
  it("binds approvals to saved pages, credits, license and price", async () => {
    await allAgree(); project().priceWei = "2000";
    await expect(curateReading("author", "comic")).rejects.toThrow(/changed/); expect(state.uploads).toBe(0);
  });
  it("clears approvals when reopened and rejects old signatures on a new version", async () => {
    await allAgree(); const old = project().reading!.key; const payload = await teamApproval("collaborator", { id: "comic" }); if (!("domain" in payload)) throw new Error("Approval payload unavailable"); const oldSignature = await collaborator.signTypedData(payload);
    await reopenReading("author", "comic"); expect(project().approvals).toEqual([]); expect(project().state).toBe("draft"); expect(project().rosterFrozen).toBe(false);
    await startTeamReview("author", { id: "comic", revision: project().revision }); expect(project().reading!.key).not.toBe(old);
    await expect(teamApproval("collaborator", { id: "comic", rights: true, signature: oldSignature }, true)).rejects.toMatchObject({ status: 401 });
  });
  it("reuses uploaded bytes on service failure and never issues a permit for a flagged review", async () => {
    await allAgree(); state.fail = true; await expect(curateReading("author", "comic")).rejects.toThrow(/Inference unavailable/); const uploads = state.uploads;
    state.fail = false; state.flagged = true; await expect(curateReading("author", "comic")).rejects.toMatchObject({ status: 409 }); expect(state.uploads).toBe(uploads);
    await expect(prepareReading("author", "comic")).rejects.toThrow(/curator review/i);
  });
  it("reserves a single durable curation job across concurrent requests", async () => {
    await allAgree(); let release!: () => void; state.hold = new Promise<void>(resolve => { release = resolve; });
    const first = curateReading("author", "comic"); await vi.waitFor(() => expect(state.reviews).toBe(1));
    await expect(curateReading("author", "comic")).rejects.toThrow(/already running/); release(); await first; expect(state.reviews).toBe(1);
  });
  it("checks every approval again before signing and prevents early reopening", async () => {
    await allAgree(); await curateReading("author", "comic"); const ready = await prepareReading("author", "comic");
    expect(await verifyTypedData({ address: reviewer.address, domain: { name: "ConsentCraftReading", version: "1", chainId: 31337, verifyingContract: project().reading!.contract }, types: readingPermitTypes, primaryType: "Permit", message: ready.permit, signature: ready.signature })).toBe(true);
    expect(ready.team.approvals).toHaveLength(2); await expect(reopenReading("author", "comic")).rejects.toThrow(/permit is still valid/);
    state.revoked.add(collaborator.address.toLowerCase()); await expect(prepareReading("author", "comic")).rejects.toThrow(/withdrawn/);
  });
  it("confirms publication idempotently and allows both purchased wallets to decrypt independently", async () => {
    await allAgree(); await curateReading("author", "comic"); await prepareReading("author", "comic"); state.published = true;
    await confirmReading("author", "comic"); await confirmReading("author", "comic"); expect(project().version).toBe(1);
    await expect(readComic("outsider", "1")).rejects.toMatchObject({ status: 403 });
    state.canRead.add(author.address.toLowerCase()); state.canRead.add(collaborator.address.toLowerCase());
    expect((await readComic("author", "1")).pages[0].dialogue).toBe("Hello"); expect((await readComic("collaborator", "1")).pages[0].dialogue).toBe("Hello");
  });
  it("blocks similarity above 85 before upload or curator inference, while allowing exactly 85", async () => {
    await allAgree(); state.similarity = 86;
    await expect(curateReading("author", "comic")).rejects.toThrow(/more than 85%/);
    expect(state.uploads).toBe(0); expect(state.reviews).toBe(0); expect(project().reading?.originality?.maxSimilarity).toBe(86);
    state.similarity = 85; await curateReading("author", "comic"); expect(project().reading?.status).toBe("approved");
  });
  it("rejects blank pages before the paid similarity scan", async () => {
    const blank = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).jpeg().toBuffer();
    project().panels[0].image = `data:image/jpeg;base64,${blank.toString("base64")}`; await allAgree();
    await expect(curateReading("author", "comic")).rejects.toThrow(/Page 1 is blank/); expect(state.scans).toBe(0); expect(state.uploads).toBe(0);
  });
  it("rebuilds public metadata from a refreshed score and signs that new metadata hash", async () => {
    await allAgree(); state.similarity = 20; await curateReading("author", "comic"); const first = await prepareReading("author", "comic");
    const initial = JSON.parse(Buffer.from(state.blobs.get(first.uri.slice(5))!).toString()); expect(initial.originality.maxSimilarity).toBe(20); expect(initial.originality).not.toHaveProperty("crux");
    state.catalogue = 1; state.similarity = 70; const second = await prepareReading("author", "comic");
    expect(second.uri).not.toBe(first.uri); const latest = JSON.parse(Buffer.from(state.blobs.get(second.uri.slice(5))!).toString());
    expect(latest.originality.maxSimilarity).toBe(70); expect(latest.originality.comparedComicCount).toBe("1");
    expect(second.permit.metadataHash).toBe(keccak256(state.blobs.get(second.uri.slice(5))!)); expect(second.permit.metadataHash).not.toBe(first.permit.metadataHash);
    state.similarity = 86; await expect(prepareReading("author", "comic")).rejects.toThrow(/more than 85%/);
  });
});
