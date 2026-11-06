import type { Address, Hex } from "viem";

import type { ListingValues, TradeValues } from "./entities.ts";

export type EntityKind = "listing" | "trade";

/** What the indexer needs to know about one entity it owns. */
export type StoredEntity = { entityKey: Hex; id: Hex; expiresAt: bigint; contentHash: Hex | undefined };

export type Written = { entityKey: Hex; expiresAt: bigint };

/** Thrown when an entity no longer exists (expired or deleted). */
export class EntityGoneError extends Error {}

/**
 * Arkiv as the indexer uses it. Only entities owned by `owner` are ever read back, because
 * anyone can write entities that carry the same schema tag.
 */
export interface EntityStore {
  readonly owner: Address;
  /** Current Arkiv block, the unit entity expiry is measured in. */
  blockNumber(): Promise<bigint>;
  blocksPerDay(): number;
  findById(kind: EntityKind, id: Hex): Promise<StoredEntity | null>;
  listOwned(kind: EntityKind, chainId: number, contract: Address): Promise<StoredEntity[]>;
  createListing(values: ListingValues, ttlDays: number): Promise<Written>;
  createTrade(values: TradeValues, ttlDays: number): Promise<Written>;
  patchListing(entityKey: Hex, values: ListingValues): Promise<void>;
  patchTrade(entityKey: Hex, values: TradeValues): Promise<void>;
  extend(entityKey: Hex, ttlDays: number): Promise<bigint>;
  remove(entityKey: Hex): Promise<void>;
}
