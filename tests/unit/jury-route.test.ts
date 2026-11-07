import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { keccak256, toBytes } from "viem";

const state = vi.hoisted(() => ({ db: { projects: [{ id: "p1", ownerId: "owner", revision: 1, panels: [], reading: { manifestHash: "0x" as `0x${string}`, bundleTxId: "bundle" } }], readingSecrets: { p1: { wrappedKey: "key" } }, juryEvidence: {} as Record<string, string>, juryJobs: {} as Record<string, { status: string; transactionHash?: string }> }, sent: 0, calls: 0, comicHash: "0x" as `0x${string}` }));
vi.mock("@/lib/store", async original => { const actual = await original<typeof import("@/lib/store")>(); return { ...actual, database: async (work: (db: typeof state.db) => unknown) => work(state.db), sessionUser: () => ({ id: "owner" }) }; });
vi.mock("@/lib/ai-jury", () => ({ juryModels: () => ["one", "two"], runJury: async () => { state.calls++; return ["one", "two"].map((model, i) => ({ model, modelId: `0x${String(i + 1).padStart(64, "0")}`, provider: `0x${"1".repeat(40)}`, requestId: model, verdict: { score: i * 100, flagged: false, reasons: [] }, verification: "gateway-reported" })); } }));
vi.mock("viem", async original => { const actual = await original<typeof import("viem")>(); return { ...actual, createPublicClient: () => ({ getChainId: async () => 31337, readContract: async ({ functionName }: { functionName: string }) => { if (functionName === "getComic") return { comicHash: state.comicHash, arweaveId: "bundle" }; if (functionName === "RELAYER_ROLE") return `0x${"1".repeat(64)}`; if (functionName === "minimumPanelSize") return 2; if (functionName === "hasRole") return true; if (functionName === "getRating") throw new Error("RatingNotFound"); }, simulateContract: async () => ({ request: {} }) }), createWalletClient: () => ({ writeContract: async () => { state.sent++; return `0x${"2".repeat(64)}`; } }) }; });
vi.mock("@/lib/server/arweave", () => ({ fetchVerified: async () => new Uint8Array() }));
vi.mock("@/lib/server/content", () => ({ unwrapKey: () => "key", openBundle: () => [] }));
import { POST } from "@/app/api/jury/route";

describe("registry jury route", () => {
  beforeEach(() => { state.db.projects[0].ownerId = "owner"; state.db.juryEvidence = {}; state.db.juryJobs = {}; state.sent = 0; state.calls = 0; state.comicHash = keccak256(toBytes("comic")); state.db.projects[0].reading.manifestHash = state.comicHash; process.env.JURY_REGISTRY_ADDRESS = `0x${"1".repeat(40)}`; process.env.JURY_REGISTRY_RPC_URL = "http://127.0.0.1:8545"; process.env.JURY_REGISTRY_CHAIN_ID = "31337"; process.env.JURY_RELAYER_PRIVATE_KEY = `0x${"1".repeat(64)}`; process.env.APP_ORIGIN = "http://localhost:3000"; });
  const request = () => new NextRequest("http://localhost:3000/api/jury", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p1", comicId: "1", rubricVersion: "1" }) });
  it("rejects a non-owner before inference and chain writes", async () => {
    state.db.projects[0].ownerId = "another-owner";
    expect((await POST(request())).status).toBe(403);
    expect(state.calls).toBe(0); expect(state.sent).toBe(0);
  });
  it("rejects a registry comic that does not match the verified bundle", async () => {
    state.db.projects[0].reading.manifestHash = keccak256(toBytes("different"));
    expect((await POST(request())).status).toBe(409);
    expect(state.calls).toBe(0); expect(state.sent).toBe(0);
  });
  it("submits a signed evidence bundle once and preserves its exact hash", async () => {
    const response = await POST(request()); expect(response.status).toBe(200);
    const result = await response.json(); expect(state.sent).toBe(1); expect(result.verification).toBe("gateway-reported");
    const evidence = state.db.juryEvidence[result.evidenceHash]; expect(keccak256(toBytes(evidence))).toBe(result.evidenceHash); expect(JSON.parse(evidence).statement.jurors).toHaveLength(2);
    expect((await POST(request())).status).toBe(409); expect(state.sent).toBe(1); expect(state.calls).toBe(1);
  });
});
