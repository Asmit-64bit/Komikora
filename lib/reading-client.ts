import { getAddress, isAddress } from "viem";
export { readingAbi } from "./reading-abi";
const raw = process.env.NEXT_PUBLIC_READING_ADDRESS;
export const readingAddress = raw && isAddress(raw) ? getAddress(raw) : undefined;
export const readingChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "31337");
export async function readingRequest<T>(body?: Record<string, unknown>, query = ""): Promise<T> {
  const response = await fetch(`/api/reading${query}`, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Reading service could not be reached."); return result as T;
}
export type ReadingComic = { id: string; author: `0x${string}`; priceWei: string; readers: string; uri: string; manifestHash: string; delisted: boolean; canRead: boolean; title: string; description: string; genre: string; license: string; cover?: string; contributors: { address: string; share: number }[] };
export type ReadingSnapshot = { comics: ReadingComic[]; total: string; credit: string; page: number; confirmations: number };
