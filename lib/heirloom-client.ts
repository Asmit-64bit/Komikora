import type { Address } from "viem";
export { heirloomAbi } from "./heirloom-abi";
export type HeirloomSnapshot = { supported: false; contract: Address; chainId: number } | {
  supported: true; contract: Address; chainId: number; owner: Address; viewer: Address; block: string; timestamp: string; credit: string; claimable: string;
  plan: { lastActivity: string; inactivityPeriod: string; challengePeriod: string; claimStartedAt: string; guardian: Address; vetoesUsed: number; configured: boolean; finalized: boolean; heirs: { address: Address; bps: number }[] };
};
export async function getHeirloom(owner: string): Promise<HeirloomSnapshot> {
  const response = await fetch(`/api/heirloom?owner=${encodeURIComponent(owner)}`, { cache: "no-store", credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Inheritance state could not be loaded.");
  return result;
}
