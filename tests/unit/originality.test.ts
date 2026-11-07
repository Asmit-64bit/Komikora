import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const state = vi.hoisted(() => ({ count: 0, result: "", project: false }));
vi.mock("@/lib/server/nft-chain", () => ({ confirmedNFT: async () => ({ address: "0x01", abi: [], blockNumber: BigInt(10), client: { readContract: async ({ functionName }: { functionName: string }) => functionName === "comicCount" ? BigInt(state.count) : ["0x01", "0xabc", "0xdef"] } }) }));
vi.mock("@/lib/server/reading-chain", () => ({ confirmedReading: async () => ({ address: "0x01", abi: [], blockNumber: BigInt(10), client: { readContract: async ({ functionName }: { functionName: string }) => functionName === "comicCount" ? BigInt(state.count) : ["0x01", "0xabc", "0xplaintext", "0xdef"] } }) }));
vi.mock("@/lib/store", async original => { const actual = await original<typeof import("@/lib/store")>(); return { ...actual, database: async (fn: (v: unknown) => unknown) => fn({ projects: state.project ? [{ id: "prior", title: "Earlier", edition: { status: "minted", key: "0xabc", manifestHash: "0xdef", bundleTxId: "id" }, reading: { status: "published", key: "0xabc", manifestHash: "0xdef", bundleTxId: "id" } }] : [], editionSecrets: { prior: { wrappedKey: "key" } }, readingSecrets: { prior: { wrappedKey: "key" } } }) }; });
vi.mock("@/lib/server/arweave", () => ({ fetchVerified: async () => new Uint8Array() }));
vi.mock("@/lib/server/content", () => ({ unwrapKey: () => "key", openBundle: () => [{ mime: "image/jpeg", image: state.result, dialogue: "", alt: "" }] }));
vi.mock("@/lib/server/private-computer", () => ({ privateCompletion: async (messages: { role: string; content: unknown }[]) => ({ content: typeof messages[1].content === "string" ? JSON.stringify({ comparisons: [{ comicId: "1", similarity: 90, relevance: "Similar characters" }] }) : JSON.stringify({ crux: "A story" }), model: "test", requestId: "req" }) }));
import { assessOriginality } from "@/lib/server/originality";
describe("originality comparison", () => {
  beforeEach(async () => { state.count = 0; state.project = false; state.result = (await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).jpeg().toBuffer()).toString("base64"); });
  const panel = () => [{ image: `data:image/jpeg;base64,${state.result}`, dialogue: "", alt: "" }];
  it("returns a zero maximum when no prior comics exist", async () => { const result = await assessOriginality(panel()); expect(result.maxSimilarity).toBe(0); expect(result.comparisons).toEqual([]); });
  it("compares verified prior comics and records their relevance", async () => { state.count = 1; state.project = true; const result = await assessOriginality(panel()); expect(result.comparisons).toEqual([{ comicId: "1", title: "Earlier", similarity: 90, relevance: "Similar characters" }]); expect(result.maxSimilarity).toBe(90); });
  it("compares previous fixed-price reading publications", async () => { state.count = 1; state.project = true; const result = await assessOriginality(panel(), "reading"); expect(result.comparisons[0].comicId).toBe("1"); expect(result.maxSimilarity).toBe(90); });
  it("fails closed when a prior comic is unavailable", async () => { state.count = 1; await expect(assessOriginality(panel())).rejects.toThrow(/cannot access published comic/); });
});
