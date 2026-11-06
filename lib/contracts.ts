import type { Address } from "viem";
import { isAddress } from "viem";
import { consentCraftMarketAbi } from "./abi";

export { consentCraftMarketAbi };

export const PublicationStateLabels = {
  0: "Deposited",
  1: "Approved",
  2: "Flagged",
  3: "Appeal pending",
  4: "Published",
  5: "Rejected",
} as const;

export const ListingStateLabels = {
  0: "Unlisted",
  1: "Listed",
  2: "Delisted",
} as const;

export const SettlementReasonLabels = {
  0: "None",
  1: "Author refund",
  2: "Threshold reached",
  3: "Rejected",
  4: "Appeal timeout",
} as const;

export function getMarketplaceAddress(): Address | undefined {
  const envAddr = process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS?.trim();
  if (envAddr && isAddress(envAddr)) {
    return envAddr;
  }
  return undefined;
}

export function truncateAddress(addr?: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
