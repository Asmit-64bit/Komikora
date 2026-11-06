import type { Address, Hex } from "viem";

/** Review state names, indexed by the contract's PublicationState enum value. */
export const REVIEW_STATUS = ["deposited", "flagged", "appeal_pending", "approved", "published", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

/** Listing state names; mirrors the contract's ListingState enum. */
export const LISTING_STATUS = ["unlisted", "listed", "delisted"] as const;
export type ListingStatus = (typeof LISTING_STATUS)[number];

export type MetadataStatus = "verified" | "unavailable" | "pending";

/** Everything the indexer derives about one publication from contract events alone. */
export type ListingProjection = {
  publicationId: bigint;
  author: Address;
  policyId: bigint;
  price: bigint;
  pageCount: number;
  previewManifestHash: Hex;
  /** 43-character Base64URL Arweave ID of the public preview manifest. */
  arweavePreviewTxId: string;
  reviewStatus: ReviewStatus;
  listingStatus: ListingStatus;
  /** R: cumulative gross sales in wei. */
  totalSales: bigint;
  salesCount: number;
  sourceTx: Hex;
  sourceBlock: bigint;
  lastEventBlock: bigint;
};

export type TradeProjection = {
  tradeId: Hex;
  listingId: Hex;
  publicationId: bigint;
  buyer: Address;
  price: bigint;
  platformFee: bigint;
  authorProceeds: bigint;
  cumulativeSales: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: Hex;
  logIndex: number;
};

/** Verified public display metadata from the Arweave preview manifest. */
export type PreviewMetadata = {
  title: string;
  titleTruncated: boolean;
  genre: string;
  language: string;
  previewRef?: string;
};

export type MetadataCacheEntry =
  | { status: "verified"; metadata: PreviewMetadata; checkedAt: string }
  | {
      status: "unavailable";
      reason: "hash_mismatch" | "fetch_failed" | "invalid_manifest" | "too_large";
      retryable: boolean;
      attempts: number;
      nextAttemptAt: string;
      checkedAt: string;
    };

export type EntityRecord<P> = { projection: P; entityKey?: Hex; contentHash?: Hex; expiresAt?: bigint };

/** Persisted indexer state. Everything except entity keys can be rebuilt from contract events. */
export type IndexerState = {
  version: 1;
  chainId: number;
  contract: Address;
  startBlock: bigint;
  lastProcessedBlock: bigint;
  lastProcessedHash: Hex | null;
  listings: Record<string, EntityRecord<ListingProjection>>;
  trades: Record<string, EntityRecord<TradeProjection>>;
  /** Keyed by previewManifestHash: content on Arweave is immutable, so a verified result never changes. */
  metadata: Record<string, MetadataCacheEntry>;
  updatedAt: string;
};

export type IndexerConfig = {
  chainId: number;
  contract: Address;
  startBlock: bigint;
  confirmations: number;
  batchBlocks: number;
  ttlDays: number;
  renewBeforeDays: number;
  retry: { attempts: number; baseDelayMs: number };
  metadataRetryMs: number;
  metadataMaxAttempts: number;
};

export type Logger = (message: string, data?: Record<string, unknown>) => void;
