import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionZeroDataError } from "viem";
const state = vi.hoisted(() => ({ mode: "supported" }));
const owner = `0x${"1".repeat(40)}` as const, heir = `0x${"2".repeat(40)}` as const;
vi.mock("@/lib/server/reading-chain", () => ({ confirmedReading: async () => ({ address: `0x${"3".repeat(40)}`, chainId: 31337, blockNumber: BigInt(12), client: {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "heirloomVersion") { if (state.mode === "old") throw new ContractFunctionZeroDataError({ functionName }); if (state.mode === "offline") throw new Error("RPC unavailable"); return BigInt(1); }
    if (functionName === "inheritancePlans") return [BigInt(100), BigInt(2592000), BigInt(604800), BigInt(0), `0x${"0".repeat(40)}`, 0, true, false];
    if (functionName === "getHeirs") return [[`0x${"2".repeat(40)}`], [10000]];
    if (functionName === "credits") return BigInt(1000);
    if (functionName === "claimableInheritedProceeds") return BigInt(0);
  }, getBlock: async () => ({ timestamp: BigInt(200) }),
} }) }));
import { heirloomSnapshot } from "@/lib/server/heirloom";
describe("inheritance snapshot", () => {
  beforeEach(() => { state.mode = "supported"; });
  it("returns confirmed plan data and the viewer's entitlement", async () => { const result = await heirloomSnapshot(owner, heir); expect(result.supported).toBe(true); if (result.supported) { expect(result.plan.heirs).toEqual([{ address: heir, bps: 10000 }]); expect(result.block).toBe("12"); expect(result.credit).toBe("1000"); } });
  it("identifies an old deployment without implying inheritance is active", async () => { state.mode = "old"; expect((await heirloomSnapshot(owner, heir)).supported).toBe(false); });
  it("preserves network failures as errors", async () => { state.mode = "offline"; await expect(heirloomSnapshot(owner, heir)).rejects.toThrow(/RPC unavailable/); });
});
