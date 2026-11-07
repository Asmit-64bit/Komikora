import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { keccak256, toHex, type Hex } from "viem";
import type { Database } from "@/lib/store";
import type { Project } from "@/lib/types";
const state = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown>, entries: [] as { key: Hex; manifest: Hex }[], image: "", calls: 0, summaryCalls: 0, comparisons: 0, downloads: 0, score: 90, fail: false, bad: "", hold: undefined as undefined | Promise<void> }));
vi.mock("@/lib/store", async original => ({ ...await original<typeof import("@/lib/store")>(), database: async (fn: (db: Database) => unknown) => { const next = state.queue.catch(() => {}).then(() => fn(state.db)); state.queue = next; return next; } }));
vi.mock("@/lib/server/reading-chain", () => ({ confirmedReading: async () => ({ address: `0x${"12".repeat(20)}`, chainId: 31337, abi: [], blockNumber: BigInt(100), client: { readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) => functionName === "comicCount" ? BigInt(state.entries.length) : ["0x01", state.entries[Number(args![0]) - 1].key, "0x00", state.entries[Number(args![0]) - 1].manifest] } }) }));
vi.mock("@/lib/server/arweave", () => ({ fetchVerified: async () => { state.downloads++; return new Uint8Array(); } }));
vi.mock("@/lib/server/content", () => ({ unwrapKey: () => new Uint8Array(), openBundle: () => [{ mime: "image/jpeg", image: state.image, dialogue: "Prior narrative", alt: "Fixture" }] }));
vi.mock("@/lib/server/private-computer", () => ({ DEFAULT_PRIVATE_MODEL: "test-model", privateCompletion: async (messages: { role: string; content: unknown }[]) => {
  state.calls++; if (state.hold) await state.hold; if (state.fail) throw new Error("Inference unavailable");
  let content: string;
  if (typeof messages[1].content === "string") {
    state.comparisons++; const input = JSON.parse(messages[1].content) as { previous: { comicId: string }[] };
    let comparisons = input.previous.map(p => ({ comicId: p.comicId, similarity: state.score, relevance: "Shared characters and plot" }));
    if (state.bad === "missing") comparisons = comparisons.slice(1);
    if (state.bad === "unknown") comparisons[0].comicId = "9999";
    if (state.bad === "duplicate") comparisons = comparisons.map(() => comparisons[0]);
    content = JSON.stringify({ comparisons });
  } else { state.summaryCalls++; content = JSON.stringify({ crux: "A concise narrative synopsis" }); }
  return { content, model: "test-model", requestId: `request-${state.calls}`, at: new Date().toISOString() };
} }));
import { assessOriginality, assertOriginalityCurrent, parsePublicOriginality } from "@/lib/server/originality";
import { publicOriginality, ORIGINALITY_VERSION } from "@/lib/originality";
const hash = (value: string) => keccak256(toHex(value));
function draft(): Project { return { id: "new", ownerId: "owner", title: "New story", description: "", theme: "", genre: "Original", members: [], panels: [{ image: `data:image/jpeg;base64,${state.image}`, dialogue: "New narrative", alt: "Fixture" }], state: "review", revision: 2, version: 0, approvals: [], terms: "Read", rosterFrozen: true, priceWei: "100", createdAt: "", updatedAt: "", events: [], reading: { key: hash("new"), contentHash: hash("new-content"), licenseHash: hash("license"), contributorsHash: hash("contributors"), priceWei: "100", approvalDeadline: 9999999999, chainId: 31337, contract: `0x${"12".repeat(20)}`, status: "team-review", approvals: [] } }; }
function addPrior(name = "prior") {
  const entry = { key: hash(name), manifest: hash(`${name}-manifest`) }; state.entries.push(entry);
  const p = draft(); p.id = name; p.title = name; p.reading = { ...p.reading!, key: entry.key, manifestHash: entry.manifest, bundleTxId: name, status: "published" };
  state.db.projects.push(p); state.db.readingSecrets ??= {}; state.db.readingSecrets[name] = { wrappedKey: "fixture" };
}
beforeEach(async () => {
  vi.stubEnv("ZG_COMPUTE_MODEL", "test-model"); state.queue = Promise.resolve(); state.entries = []; state.calls = 0; state.summaryCalls = 0; state.comparisons = 0; state.downloads = 0; state.score = 90; state.fail = false; state.bad = ""; state.hold = undefined;
  const pixels = Buffer.from(Array.from({ length: 8 * 8 * 3 }, (_, i) => Math.floor(i / 3) % 2 ? 255 : 0));
  state.image = (await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } }).jpeg().toBuffer()).toString("base64");
  state.db = { users: [], sessions: [], invitations: [], projects: [draft()] };
});
afterEach(() => vi.unstubAllEnvs());
const scan = () => assessOriginality(structuredClone(state.db.projects[0]));
describe("fixed-price reading similarity scanner", () => {
  it("compares the reading catalogue and records provider request IDs", async () => {
    addPrior(); const result = await scan(); expect(result.maxSimilarity).toBe(90); expect(result.comparedComicCount).toBe("1"); expect(result.comparisons).toEqual([{ comicId: "1", title: "prior", similarity: 90, relevance: "Shared characters and plot" }]);
    expect(result.comparisonRequestIds).toHaveLength(1); expect(state.calls).toBe(3); expect(state.downloads).toBe(1);
    expect(state.db.projects[0].reading?.originality).toEqual(result);
  });
  it("reuses rejected results without spending quota or inference again", async () => {
    addPrior(); for (let i = 0; i < 6; i++) expect((await scan()).maxSimilarity).toBe(90);
    expect(state.calls).toBe(3); expect(state.db.originalityAttempts).toHaveLength(1);
  });
  it("charges failed scan attempts before inference and enforces the daily limit", async () => {
    state.fail = true;
    for (let i = 0; i < 5; i++) await expect(scan()).rejects.toThrow("Inference unavailable");
    await expect(scan()).rejects.toMatchObject({ status: 429 });
    expect(state.calls).toBe(5); expect(state.db.originalityAttempts).toHaveLength(5); expect(state.db.originalityJobs?.new).toBeUndefined();
  });
  it("reuses verified synopses when the catalogue grows", async () => {
    addPrior(); const first = await scan(); expect(state.summaryCalls).toBe(2);
    addPrior("second"); await expect(assertOriginalityCurrent(first)).rejects.toMatchObject({ status: 409 });
    const second = await scan(); expect(second.comparedComicCount).toBe("2"); expect(state.summaryCalls).toBe(3); expect(state.comparisons).toBe(2); expect(state.downloads).toBe(2);
  });
  it("detects changed fingerprints even if the confirmed catalogue count is unchanged", async () => {
    addPrior(); const first = await scan(); state.entries[0].manifest = hash("replacement"); state.db.projects[1].reading!.manifestHash = state.entries[0].manifest;
    await expect(assertOriginalityCurrent(first)).rejects.toMatchObject({ status: 409 }); expect((await scan()).catalogueHash).not.toBe(first.catalogueHash);
  });
  it.each(["missing", "unknown", "duplicate"])("fails closed on %s comparison IDs", async bad => {
    addPrior(); addPrior("second"); state.bad = bad; await expect(scan()).rejects.toMatchObject({ status: 502 }); expect(state.db.projects[0].reading?.originality).toBeUndefined();
  });
  it("rejects missing prior content/key before paid inference", async () => {
    addPrior(); delete state.db.readingSecrets!.prior; await expect(scan()).rejects.toMatchObject({ status: 503 }); expect(state.calls).toBe(0); expect(state.db.originalityAttempts).toBeUndefined();
  });
  it("serializes similarity jobs across server instances", async () => {
    let release!: () => void; state.hold = new Promise<void>(resolve => { release = resolve; }); const first = scan();
    await vi.waitFor(() => expect(state.calls).toBe(1)); await expect(scan()).rejects.toMatchObject({ status: 409 }); release(); await first;
    expect(state.db.originalityAttempts).toHaveLength(1);
  });
  it("omits the private synopsis from public metadata and validates public findings", async () => {
    const result = await scan(); expect(result.maxSimilarity).toBe(0); expect(result.version).toBe(ORIGINALITY_VERSION);
    const publicResult = publicOriginality(result); expect(publicResult).not.toHaveProperty("crux");
    expect(parsePublicOriginality({ ...publicResult, crux: "Private plot" })).not.toHaveProperty("crux"); expect(parsePublicOriginality({ ...publicResult, maxSimilarity: 101 })).toBeUndefined();
  });
});
