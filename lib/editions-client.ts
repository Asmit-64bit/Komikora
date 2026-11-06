import { getAddress, isAddress } from "viem";
export { editionsAbi } from "./editions-abi";
const raw = process.env.NEXT_PUBLIC_EDITIONS_ADDRESS;
export const editionsAddress = raw && isAddress(raw) ? getAddress(raw) : undefined;
export const editionsChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "31337");
export async function editionRequest<T>(body?: Record<string, unknown>, query = ""): Promise<T> {
  const res = await fetch(`/api/editions${query}`, { method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || "Edition request failed."); return result;
}
export type EditionToken = {
  id: string; comicId: string; author: string; supply: number; owner: string; depositor: string; title: string; description: string; genre: string; license: string; cover?: string; uri: string; manifestHash: string; metadataHash: string; delisted: boolean;
  sale: [string, string, string, string, string]; auction: [string, string, string, string, string, string, boolean]; ask: [string, string, string]; minimum: string;
  firstAuction?: { reserveWei: string; duration: number };
  review?: { score: number; reasons: string[]; model: string; provider: string; promptVersion: string; at: string; teeVerified: boolean; uncertainty: string; requestId?: string; verification?: string; assessment?: { completeness: string; legibility: string; pageOrder: string } }; reviewOverride?: { reason: string };
};
export type EditionSnapshot = { tokens: EditionToken[]; deals: { id: string; maker: string; token: EditionToken; value: string; end: string; active: boolean }[]; offers: { id: string; maker: string; dealId: string; token: EditionToken; target: EditionToken; topUp: string; active: boolean; dealMaker: string; end: string; dealActive: boolean }[]; total: string; credit: string; timestamp: string; block: string; confirmations: number };
