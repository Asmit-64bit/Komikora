import "server-only";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
import { addr, str, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, isAddress, type Address } from "viem";
import { EditionIndex } from "@/indexer/src/edition-schema";
import { envValue } from "./env";
export async function discoverEditions(contract: Address, chainId: number, page: number, phase: string, genre?: string) {
  const accessKey = envValue("ARKIV_ACCESS_KEY"); const writer = envValue("ARKIV_WRITER_ADDRESS");
  if (!writer || !isAddress(writer) || !["primary", "secondary"].includes(phase) || page > 80) return undefined;
  try {
    const client = createPublicClient({ chain: rabdi({ accessKey: accessKey || "" }), transport: http(undefined, { timeout: 8000, retryCount: 0 }) });
    const conditions = [eq("chainId", u64(chainId)), eq("contract", addr(contract)), eq("kind", str("token")), eq("phase", str(phase)), ...(genre ? [eq("genre", str(genre))] : [])];
    const rows = await client.select({ tokenId: true }).from(EditionIndex).where(and(...conditions)).ownedBy(getAddress(writer)).orderBy(desc("tokenId")).limit((page + 1) * 12 + 1).fetch();
    if (!rows.entities.length) return undefined;
    return { ids: rows.entities.slice(page * 12, page * 12 + 12).map(r => r.tokenId.value), total: rows.entities.length };
  } catch { return undefined; } // Discovery can lag/fail. Funds and access always use chain state.
}
