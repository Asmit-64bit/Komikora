// Client-safe contract constants. Enum values match IConsentCraftMarketTypes.sol.
import { getAddress, isAddress, type Address } from "viem";
import { consentCraftMarketAbi } from "./abi";

export { consentCraftMarketAbi };

export const PublicationState = { Deposited: 0, Flagged: 1, AppealPending: 2, Approved: 3, Published: 4, Rejected: 5 } as const;
export const ListingState = { Unlisted: 0, Listed: 1, Delisted: 2 } as const;
export const SettlementReason = { None: 0, Rejected: 1, AppealTimeout: 2, ThresholdReached: 3, AuthorRefund: 4 } as const;

export const PublicationStateLabels: Record<number, string> = {
  0: "Awaiting AI review", 1: "Flagged by review", 2: "Appeal pending", 3: "Approved", 4: "Published", 5: "Rejected",
};
export const ListingStateLabels: Record<number, string> = { 0: "Not listed", 1: "On sale", 2: "Delisted" };
export const SettlementReasonLabels: Record<number, string> = {
  0: "Deposit still locked", 1: "Rejected", 2: "Appeal timed out", 3: "Sales reached the deposit", 4: "Author refund",
};

export const MARKET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "0");

export function getMarketplaceAddress(): Address | undefined {
  const value = process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS?.trim();
  return value && isAddress(value) ? getAddress(value) : undefined;
}

export function explorerTx(hash: string) {
  if (MARKET_CHAIN_ID === 11155111) return `https://sepolia.etherscan.io/tx/${hash}`;
  return undefined;
}

export function explorerAddress(address: string) {
  if (MARKET_CHAIN_ID === 11155111) return `https://sepolia.etherscan.io/address/${address}`;
  return undefined;
}

export function truncateAddress(addr?: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
