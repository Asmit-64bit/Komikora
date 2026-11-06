/**
 * Read helpers for the frontend. They query Arkiv directly and need no private key.
 *
 * Every query is scoped to the trusted indexer wallet (`writer`): anyone can write entities that
 * carry the same schema tag, so results from other owners are never returned.
 *
 * These entities are a convenience index. Payment, ownership and reading access must always be
 * checked against the contract (`hasReadingAccess`), never against Arkiv.
 */
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { and, asc, desc, eq, gt, gte, lte, type Expression } from "@arkiv-network/sdk/query";
import { addr, key, str, u256, u64 } from "@arkiv-network/sdk/schema";
import type { Address, Hex } from "viem";

import { ListingSchema, TradeSchema } from "./entities.ts";
import type { ListingStatus, ReviewStatus } from "./types.ts";

export type ListingSearch = {
  writer: Address;
  chainId?: number;
  contract?: Address;
  genre?: string;
  language?: string;
  author?: Address;
  minPrice?: bigint;
  maxPrice?: bigint;
  reviewStatus?: ReviewStatus;
  /** Defaults to "listed" (purchasable). Pass "any" to include unlisted and delisted. */
  listingStatus?: ListingStatus | "any";
  /** Defaults to only listings whose display metadata was verified. */
  includeUnverified?: boolean;
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: Hex;
};

export type ListingRow = {
  entityKey: Hex;
  publicationId: bigint;
  author: Address;
  title?: string;
  genre?: string;
  language?: string;
  price: bigint;
  pageCount: bigint;
  previewRef?: string;
  arweavePreviewTxId: string;
  metadataStatus: string;
  reviewStatus: string;
  listingStatus: string;
  totalSales: bigint;
  salesCount: bigint;
  policyId: bigint;
  sourceTx: Hex;
  expiresAt: bigint;
};

export type TradeRow = {
  entityKey: Hex;
  publicationId: bigint;
  buyer: Address;
  price: bigint;
  platformFee: bigint;
  authorProceeds: bigint;
  cumulativeSales: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: Hex;
  logIndex: bigint;
};

/** The predicates a listing search sends; exported so they can be inspected and tested. */
export function listingFilters(q: Omit<ListingSearch, "writer" | "limit">): Expression[] {
  const f: Expression[] = [];
  if (q.chainId !== undefined) f.push(eq("chainId", u64(q.chainId)));
  if (q.contract) f.push(eq("contract", addr(q.contract)));
  if (q.genre) f.push(eq("genre", str(q.genre.trim().toLowerCase())));
  if (q.language) f.push(eq("language", str(q.language.trim().toLowerCase())));
  if (q.author) f.push(eq("author", addr(q.author)));
  if (q.minPrice !== undefined) f.push(gte("price", u256(q.minPrice)));
  if (q.maxPrice !== undefined) f.push(lte("price", u256(q.maxPrice)));
  if (q.reviewStatus) f.push(eq("reviewStatus", str(q.reviewStatus)));
  const listing = q.listingStatus ?? "listed";
  if (listing !== "any") f.push(eq("listingStatus", str(listing)));
  if (!q.includeUnverified) f.push(eq("metadataStatus", str("verified")));
  if (q.cursor) f.push(gt("$key", key(q.cursor)));
  return f;
}

export function buildListingQuery(client: PublicArkivClient, q: ListingSearch) {
  const filters = listingFilters(q);
  const builder = client.select().from(ListingSchema).ownedBy(q.writer).orderBy(asc("$key")).limit(Math.min(q.limit ?? 20, 100));
  // The filter list is built dynamically, so it cannot be checked against the schema at compile
  // time; the SDK still checks every predicate against ListingSchema at runtime.
  return filters.length > 0 ? builder.where(and(...filters) as never) : builder;
}

/** Searches listings by genre, language, author, price range and status. Cursor-paginated. */
export async function searchListings(client: PublicArkivClient, q: ListingSearch): Promise<{ listings: ListingRow[]; nextCursor?: Hex }> {
  const page = await buildListingQuery(client, q).fetch();
  const listings = page.entities.map(
    (r): ListingRow => ({
      entityKey: r.$key,
      publicationId: r.publicationId.value,
      author: r.author.value,
      ...(r.title && { title: r.title.value }),
      ...(r.genre && { genre: r.genre.value }),
      ...(r.language && { language: r.language.value }),
      price: r.price.value,
      pageCount: r.pageCount.value,
      ...(r.previewRef && { previewRef: r.previewRef.value }),
      arweavePreviewTxId: r.arweavePreviewTxId.value,
      metadataStatus: r.metadataStatus.value,
      reviewStatus: r.reviewStatus.value,
      listingStatus: r.listingStatus.value,
      totalSales: r.totalSales.value,
      salesCount: r.salesCount.value,
      policyId: r.policyId.value,
      sourceTx: r.sourceTx.value,
      expiresAt: r.$expiresAt,
    }),
  );
  const limit = Math.min(q.limit ?? 20, 100);
  return { listings, ...(page.entities.length === limit && { nextCursor: page.entities.at(-1)!.$key }) };
}

export type TradeQuery = { writer: Address; chainId?: number; contract?: Address; publicationId?: bigint; limit?: number };

export function buildTradeQuery(client: PublicArkivClient, q: TradeQuery) {
  const f: Expression[] = [];
  if (q.chainId !== undefined) f.push(eq("chainId", u64(q.chainId)));
  if (q.contract) f.push(eq("contract", addr(q.contract)));
  if (q.publicationId !== undefined) f.push(eq("publicationId", u64(q.publicationId)));
  const builder = client.select().from(TradeSchema).ownedBy(q.writer).orderBy(desc("feedOrder")).limit(Math.min(q.limit ?? 20, 100));
  return f.length > 0 ? builder.where(and(...f) as never) : builder; // runtime-checked, as above
}

/** Most recent trades, overall or for one comic. */
export async function recentTrades(client: PublicArkivClient, q: TradeQuery): Promise<TradeRow[]> {
  const page = await buildTradeQuery(client, q).fetch();
  return page.entities.map((r) => ({
    entityKey: r.$key,
    publicationId: r.publicationId.value,
    buyer: r.buyer.value,
    price: r.price.value,
    platformFee: r.platformFee.value,
    authorProceeds: r.authorProceeds.value,
    cumulativeSales: r.cumulativeSales.value,
    blockNumber: r.blockNumber.value,
    timestamp: r.timestamp.value,
    txHash: r.txHash.value,
    logIndex: r.logIndex.value,
  }));
}
