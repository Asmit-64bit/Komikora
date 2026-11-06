/**
 * Arkiv entity schemas and value builders for listings and trades.
 *
 * Arkiv data is public. These entities hold only public marketplace data. They never hold
 * decryption keys, page content, World ID proofs, appeal evidence, review rationale, or the
 * encrypted bundle's Arweave ID.
 */
import { addr, defineSchema, key, str, u256, u64 } from "@arkiv-network/sdk/schema";
import { keccak256, toHex, type Address, type Hex } from "viem";

import { listingId } from "./projection.ts";
import type { ListingProjection, MetadataCacheEntry, TradeProjection } from "./types.ts";

export const SCHEMA_VERSION = 1n;
export const LISTING_SCHEMA_NAME = "consentcraft.listing.v1";
export const TRADE_SCHEMA_NAME = "consentcraft.trade.v1";

export const ListingSchema = defineSchema(LISTING_SCHEMA_NAME, {
  listingId: key().indexed(),
  chainId: u64().indexed(),
  contract: addr().indexed(),
  publicationId: u64().indexed(),
  author: addr().indexed(),
  title: str().optional(),
  genre: str().indexed().optional(),
  language: str().indexed().optional(),
  price: u256().indexed(),
  pageCount: u64(),
  previewRef: str().optional(),
  arweavePreviewTxId: str(),
  previewManifestHash: key(),
  metadataStatus: str().indexed(),
  reviewStatus: str().indexed(),
  listingStatus: str().indexed(),
  totalSales: u256(),
  salesCount: u64(),
  policyId: u64().indexed(),
  sourceTx: key(),
  sourceBlock: u64(),
  lastEventBlock: u64(),
  contentHash: key(),
  schemaVersion: u64().indexed(),
});

export const TradeSchema = defineSchema(TRADE_SCHEMA_NAME, {
  tradeId: key().indexed(),
  listingId: key().indexed(),
  chainId: u64().indexed(),
  contract: addr().indexed(),
  publicationId: u64().indexed(),
  buyer: addr().indexed(),
  price: u256(),
  platformFee: u256(),
  authorProceeds: u256(),
  cumulativeSales: u256(),
  blockNumber: u64().indexed(),
  timestamp: u64(),
  txHash: key(),
  logIndex: u64(),
  /** blockNumber * 1e6 + logIndex: a single sortable key for the trade feed. */
  feedOrder: u64(),
  contentHash: key(),
  schemaVersion: u64().indexed(),
});

/** Plain listing values, independent of the SDK's typed value wrappers. */
export type ListingValues = {
  listingId: Hex;
  chainId: bigint;
  contract: Address;
  publicationId: bigint;
  author: Address;
  title?: string;
  genre?: string;
  language?: string;
  price: bigint;
  pageCount: bigint;
  previewRef?: string;
  arweavePreviewTxId: string;
  previewManifestHash: Hex;
  metadataStatus: "verified" | "unavailable" | "pending";
  reviewStatus: string;
  listingStatus: string;
  totalSales: bigint;
  salesCount: bigint;
  policyId: bigint;
  sourceTx: Hex;
  sourceBlock: bigint;
  lastEventBlock: bigint;
  contentHash: Hex;
  schemaVersion: bigint;
};

export type TradeValues = {
  tradeId: Hex;
  listingId: Hex;
  chainId: bigint;
  contract: Address;
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
  feedOrder: bigint;
  contentHash: Hex;
  schemaVersion: bigint;
};

function hashValues(values: Record<string, unknown>): Hex {
  const canonical = JSON.stringify(
    Object.keys(values)
      .filter((k) => k !== "contentHash" && values[k] !== undefined)
      .sort()
      .map((k) => [k, typeof values[k] === "bigint" ? `${values[k]}n` : values[k]]),
  );
  return keccak256(toHex(canonical));
}

export function buildListingValues(
  chainId: number,
  contract: Address,
  l: ListingProjection,
  metadata: MetadataCacheEntry | undefined,
): ListingValues {
  const values: Omit<ListingValues, "contentHash"> & { contentHash?: Hex } = {
    listingId: listingId(chainId, contract, l.publicationId),
    chainId: BigInt(chainId),
    contract,
    publicationId: l.publicationId,
    author: l.author,
    price: l.price,
    pageCount: BigInt(l.pageCount),
    arweavePreviewTxId: l.arweavePreviewTxId,
    previewManifestHash: l.previewManifestHash,
    metadataStatus: metadata === undefined ? "pending" : metadata.status,
    reviewStatus: l.reviewStatus,
    listingStatus: l.listingStatus,
    totalSales: l.totalSales,
    salesCount: BigInt(l.salesCount),
    policyId: l.policyId,
    sourceTx: l.sourceTx,
    sourceBlock: l.sourceBlock,
    lastEventBlock: l.lastEventBlock,
    schemaVersion: SCHEMA_VERSION,
  };
  // Display metadata is copied only when it was verified against previewManifestHash.
  if (metadata?.status === "verified") {
    values.title = metadata.metadata.title;
    values.genre = metadata.metadata.genre;
    values.language = metadata.metadata.language;
    if (metadata.metadata.previewRef) values.previewRef = metadata.metadata.previewRef;
  }
  return { ...values, contentHash: hashValues(values) };
}

export function buildTradeValues(chainId: number, contract: Address, t: TradeProjection): TradeValues {
  const values: Omit<TradeValues, "contentHash"> = {
    tradeId: t.tradeId,
    listingId: t.listingId,
    chainId: BigInt(chainId),
    contract,
    publicationId: t.publicationId,
    buyer: t.buyer,
    price: t.price,
    platformFee: t.platformFee,
    authorProceeds: t.authorProceeds,
    cumulativeSales: t.cumulativeSales,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    txHash: t.txHash,
    logIndex: BigInt(t.logIndex),
    feedOrder: t.blockNumber * 1_000_000n + BigInt(t.logIndex),
    schemaVersion: SCHEMA_VERSION,
  };
  return { ...values, contentHash: hashValues(values) };
}

/** Wraps plain values in the SDK's typed values for a write. */
export function toListingAttributes(v: ListingValues) {
  return {
    listingId: key(v.listingId),
    chainId: u64(v.chainId),
    contract: addr(v.contract),
    publicationId: u64(v.publicationId),
    author: addr(v.author),
    ...(v.title !== undefined && { title: str(v.title) }),
    ...(v.genre !== undefined && { genre: str(v.genre) }),
    ...(v.language !== undefined && { language: str(v.language) }),
    price: u256(v.price),
    pageCount: u64(v.pageCount),
    ...(v.previewRef !== undefined && { previewRef: str(v.previewRef) }),
    arweavePreviewTxId: str(v.arweavePreviewTxId),
    previewManifestHash: key(v.previewManifestHash),
    metadataStatus: str(v.metadataStatus),
    reviewStatus: str(v.reviewStatus),
    listingStatus: str(v.listingStatus),
    totalSales: u256(v.totalSales),
    salesCount: u64(v.salesCount),
    policyId: u64(v.policyId),
    sourceTx: key(v.sourceTx),
    sourceBlock: u64(v.sourceBlock),
    lastEventBlock: u64(v.lastEventBlock),
    contentHash: key(v.contentHash),
    schemaVersion: u64(v.schemaVersion),
  };
}

export function toTradeAttributes(v: TradeValues) {
  return {
    tradeId: key(v.tradeId),
    listingId: key(v.listingId),
    chainId: u64(v.chainId),
    contract: addr(v.contract),
    publicationId: u64(v.publicationId),
    buyer: addr(v.buyer),
    price: u256(v.price),
    platformFee: u256(v.platformFee),
    authorProceeds: u256(v.authorProceeds),
    cumulativeSales: u256(v.cumulativeSales),
    blockNumber: u64(v.blockNumber),
    timestamp: u64(v.timestamp),
    txHash: key(v.txHash),
    logIndex: u64(v.logIndex),
    feedOrder: u64(v.feedOrder),
    contentHash: key(v.contentHash),
    schemaVersion: u64(v.schemaVersion),
  };
}

/** Optional listing columns a patch must clear when metadata is no longer verified. */
export const OPTIONAL_LISTING_COLUMNS = ["title", "genre", "language", "previewRef"] as const;
