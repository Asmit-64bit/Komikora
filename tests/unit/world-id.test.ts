import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { Database } from "@/lib/store";
import type { User } from "@/lib/types";

let world: typeof import("@/lib/server/world-id");
let db: Database;
const alice: User = { id: "alice", name: "Alice", color: "purple", address: "0x1111111111111111111111111111111111111111" };
const bob: User = { id: "bob", name: "Bob", color: "purple", address: "0x2222222222222222222222222222222222222222" };

beforeAll(async () => {
  Object.assign(process.env, { NEXT_PUBLIC_WORLD_APP_ID: "app_test", WORLD_RP_ID: "rp_test", WORLD_RP_SIGNING_KEY: `0x${"ab".repeat(32)}`, WORLD_ACTION: "verify-account" });
  world = await import("@/lib/server/world-id");
});
beforeEach(() => { db = { users: [{ ...alice }, { ...bob }], sessions: [], projects: [], invitations: [] }; });

/** A proof result shaped like IDKit 4 output. Only the Developer Portal call is faked. */
function result(nonce: string, user: User, overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0", nonce, action: "verify-account", environment: "production",
    responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(user.address), proof: ["1", "2", "3", "4", "5"], nullifier: "12345", issuer_schema_id: 1, expires_at_min: 0 }],
    ...overrides,
  };
}
const portal = (ok: boolean, calls: unknown[] = []) => (async (_url: unknown, init?: RequestInit) => {
  calls.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify(ok ? { success: true } : { success: false, code: "invalid_proof" }), { status: ok ? 200 : 400 });
}) as typeof fetch;

describe("World ID 4 verification", () => {
  it("verifies with the portal, links the nullifier and marks the account", async () => {
    const start = world.startVerification(db, alice);
    expect(start.signal).toBe(alice.address);
    expect(start.rp_context.rp_id).toBe("rp_test");
    const calls: unknown[] = [];
    await world.completeVerification(db, alice, result(start.rp_context.nonce, alice), portal(true, calls));
    expect(calls).toHaveLength(1);
    expect(db.users[0].worldIdVerifiedAt).toBeTruthy();
    expect(Object.values(db.worldIdNullifiers!)).toEqual(["alice"]);
    expect(JSON.stringify(db)).not.toContain("12345"); // raw nullifier is never stored
  });

  it("rejects a replayed request nonce", async () => {
    const start = world.startVerification(db, alice);
    await world.completeVerification(db, alice, result(start.rp_context.nonce, alice), portal(true));
    db.users[0].worldIdVerifiedAt = undefined;
    await expect(world.completeVerification(db, alice, result(start.rp_context.nonce, alice), portal(true))).rejects.toThrow(/expired or was already used/);
  });

  it("rejects a proof made for another wallet", async () => {
    const start = world.startVerification(db, alice);
    await expect(world.completeVerification(db, alice, result(start.rp_context.nonce, bob), portal(true))).rejects.toThrow(/different wallet/);
  });

  it("rejects another user's request nonce", async () => {
    const start = world.startVerification(db, alice);
    await expect(world.completeVerification(db, bob, result(start.rp_context.nonce, bob), portal(true))).rejects.toThrow(/expired or was already used/);
  });

  it("rejects legacy, wrong-action and wrong-environment proofs before calling the portal", async () => {
    const calls: unknown[] = [];
    for (const overrides of [{ protocol_version: "3.0" }, { action: "other" }, { environment: "staging" }]) {
      const start = world.startVerification(db, alice);
      await expect(world.completeVerification(db, alice, result(start.rp_context.nonce, alice, overrides), portal(true, calls))).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("does not mark the account when the portal rejects the proof", async () => {
    const start = world.startVerification(db, alice);
    await expect(world.completeVerification(db, alice, result(start.rp_context.nonce, alice), portal(false))).rejects.toThrow(/rejected this proof/);
    expect(db.users[0].worldIdVerifiedAt).toBeUndefined();
  });

  it("allows one human per account", async () => {
    const a = world.startVerification(db, alice);
    await world.completeVerification(db, alice, result(a.rp_context.nonce, alice), portal(true));
    const b = world.startVerification(db, bob);
    await expect(world.completeVerification(db, bob, result(b.rp_context.nonce, bob), portal(true))).rejects.toThrow(/already linked to another/);
    expect(db.users[1].worldIdVerifiedAt).toBeUndefined();
  });

  it("refuses to start for an already verified account", async () => {
    db.users[0].worldIdVerifiedAt = new Date().toISOString();
    expect(() => world.startVerification(db, db.users[0] as User)).toThrow(/already verified/);
  });
});
