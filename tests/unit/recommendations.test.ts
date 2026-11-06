import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/store";
import type { EditionSnapshot, EditionToken } from "@/lib/editions-client";
const state = vi.hoisted(() => ({ db: {} as Database, snapshot: {} as EditionSnapshot, content: "", fail: false, calls: 0 }));
vi.mock("@/lib/store", async original => ({ ...await original<typeof import("@/lib/store")>(), database: async (work: (db: Database) => unknown) => work(state.db) }));
vi.mock("@/lib/server/nft-snapshot", () => ({ editionSnapshot: async () => state.snapshot }));
vi.mock("@/lib/server/private-computer", () => ({ privateCompletion: async () => { state.calls++; if (state.fail) throw new Error("Private provider unavailable"); return { content: state.content, requestId: "private-fixture", model: "fixture-model", at: new Date().toISOString() }; } }));
import { recommendEditions } from "@/lib/server/recommendations";
beforeEach(() => {
  state.db = { users: [{ id: "collector", address: `0x${"11".repeat(20)}`, name: "Collector", color: "purple" }], sessions: [{ token: "session", userId: "collector", expires: Date.now() + 100000, auth: "wallet" }], projects: [], invitations: [] };
  state.snapshot = { timestamp: "100", tokens: [{ id: "1", title: "Space friends", genre: "Sci-fi", description: "A space adventure", sale: ["0", "0", "0", "0", "0"], auction: ["", "", "", "", "200", "", true], delisted: false } as EditionToken] } as EditionSnapshot;
  state.calls = 0; state.fail = false; state.content = JSON.stringify({ picks: [{ tokenId: "1", reason: "Matches your interest in space." }] });
});
describe("private curator suggestions", () => {
  it("requires a wallet session and avoids inference without eligible auctions", async () => {
    await expect(recommendEditions(undefined, "space")).rejects.toThrow(/Sign in/);
    state.snapshot.tokens[0].delisted = true;
    expect((await recommendEditions("session", "space")).picks).toEqual([]); expect(state.calls).toBe(0);
  });
  it("returns catalog-linked suggestions with provenance and reuses cached results", async () => {
    const result = await recommendEditions("session", "space");
    expect(result.picks[0]).toMatchObject({ tokenId: "1", title: "Space friends" });
    expect(result).toMatchObject({ requestId: "private-fixture", promptVersion: "consentcraft-discovery-v1" });
    await recommendEditions("session", "space"); expect(state.calls).toBe(1);
  });
  it("rejects invented IDs, duplicate picks and malformed answers", async () => {
    for (const content of ['{"picks":[{"tokenId":"999","reason":"Unknown"}]}', '{"picks":[{"tokenId":"1","reason":"One"},{"tokenId":"1","reason":"Again"}]}', "not json"]) {
      state.content = content; await expect(recommendEditions("session", "space")).rejects.toThrow(/invalid|unknown or duplicate/);
    }
    expect(state.db.curatorSuggestions).toBeUndefined();
  });
  it("does not fabricate suggestions after a provider failure or exhausted quota", async () => {
    state.fail = true; await expect(recommendEditions("session", "space")).rejects.toThrow(/unavailable/);
    state.db.curatorRequests = Array.from({ length: 15 }, () => ({ userId: "collector", at: Date.now() }));
    await expect(recommendEditions("session", "space")).rejects.toThrow(/limit/); expect(state.calls).toBe(1);
  });
});
