import { createPublicClient, createWalletClient, ExpirationTime, NoEntityFoundError } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { addr, key, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ListingSchema,
  OPTIONAL_LISTING_COLUMNS,
  TradeSchema,
  toListingAttributes,
  toTradeAttributes,
  type ListingValues,
  type TradeValues,
} from "./entities.ts";
import { EntityGoneError, type EntityKind, type EntityStore, type StoredEntity } from "./store.ts";

/** Arkiv uses 2-second blocks (SDK BLOCK_TIME). */
const BLOCKS_PER_DAY = 43_200;
const PAGE = 100;

export type ArkivConnection = {
  accessKey: string;
  /** Writer key. Omit for read-only use (queries, judges). */
  privateKey?: Hex;
  /** Owner to trust when reading; defaults to the writer's address. */
  owner?: Address;
};

export function arkivChain(accessKey: string) {
  return rabdi({ accessKey });
}

export function arkivPublicClient(accessKey: string) {
  return createPublicClient({ chain: arkivChain(accessKey), transport: http() });
}

export function createArkivStore(conn: ArkivConnection): EntityStore {
  const chain = arkivChain(conn.accessKey);
  const publicClient = createPublicClient({ chain, transport: http() });
  const account = conn.privateKey ? privateKeyToAccount(conn.privateKey) : undefined;
  const walletClient = account ? createWalletClient({ chain, transport: http(), account }) : undefined;
  const owner = getAddress(conn.owner ?? account?.address ?? "");
  const wallet = () => {
    if (!walletClient) throw new Error("ARKIV_PRIVATE_KEY is required for writes");
    return walletClient;
  };
  const expiration = (ttlDays: number) => ExpirationTime.fromDays(ttlDays);
  const gone = (err: unknown, entityKey: Hex) => {
    if (err instanceof NoEntityFoundError) return new EntityGoneError(`Entity ${entityKey} is gone`);
    return err;
  };

  async function findListing(id: Hex): Promise<StoredEntity | null> {
    const r = await publicClient
      .select({ $key: true, $expiresAt: true, contentHash: true })
      .from(ListingSchema)
      .where(eq("listingId", key(id)))
      .ownedBy(owner)
      .limit(1)
      .fetch();
    const row = r.entities[0];
    return row ? { entityKey: row.$key, id, expiresAt: row.$expiresAt, contentHash: row.contentHash.value } : null;
  }

  async function findTrade(id: Hex): Promise<StoredEntity | null> {
    const r = await publicClient
      .select({ $key: true, $expiresAt: true, contentHash: true })
      .from(TradeSchema)
      .where(eq("tradeId", key(id)))
      .ownedBy(owner)
      .limit(1)
      .fetch();
    const row = r.entities[0];
    return row ? { entityKey: row.$key, id, expiresAt: row.$expiresAt, contentHash: row.contentHash.value } : null;
  }

  return {
    owner,
    blockNumber: () => publicClient.getBlockNumber(),
    blocksPerDay: () => BLOCKS_PER_DAY,
    findById: (kind, id) => (kind === "listing" ? findListing(id) : findTrade(id)),

    async listOwned(kind: EntityKind, chainId: number, contract: Address) {
      const out: StoredEntity[] = [];
      let after: Hex | undefined;
      for (;;) {
        const scope = [eq("chainId", u64(chainId)), eq("contract", addr(contract))];
        const where = after ? and(...scope, gt("$key", key(after))) : and(...scope);
        if (kind === "listing") {
          const page = await publicClient
            .select({ $key: true, $expiresAt: true, listingId: true, contentHash: true })
            .from(ListingSchema, { onMismatch: "throw" })
            .where(where)
            .ownedBy(owner)
            .orderBy(asc("$key"))
            .limit(PAGE)
            .fetch();
          for (const r of page.entities) {
            out.push({ entityKey: r.$key, id: r.listingId.value, expiresAt: r.$expiresAt, contentHash: r.contentHash.value });
          }
          if (page.entities.length < PAGE) break;
          after = page.entities.at(-1)!.$key;
        } else {
          const page = await publicClient
            .select({ $key: true, $expiresAt: true, tradeId: true, contentHash: true })
            .from(TradeSchema, { onMismatch: "throw" })
            .where(where)
            .ownedBy(owner)
            .orderBy(asc("$key"))
            .limit(PAGE)
            .fetch();
          for (const r of page.entities) {
            out.push({ entityKey: r.$key, id: r.tradeId.value, expiresAt: r.$expiresAt, contentHash: r.contentHash.value });
          }
          if (page.entities.length < PAGE) break;
          after = page.entities.at(-1)!.$key;
        }
      }
      return out;
    },

    async createListing(values: ListingValues, ttlDays: number) {
      const r = await wallet().createEntity(ListingSchema, toListingAttributes(values), { expiration: expiration(ttlDays) });
      return { entityKey: r.entityKey, expiresAt: r.expiresAt };
    },
    async createTrade(values: TradeValues, ttlDays: number) {
      const r = await wallet().createEntity(TradeSchema, toTradeAttributes(values), { expiration: expiration(ttlDays) });
      return { entityKey: r.entityKey, expiresAt: r.expiresAt };
    },
    async patchListing(entityKey, values) {
      const set = toListingAttributes(values);
      const unset = OPTIONAL_LISTING_COLUMNS.filter((c) => values[c] === undefined);
      try {
        await wallet().patchEntity(ListingSchema, entityKey, { set, ...(unset.length > 0 && { unset }) });
      } catch (err) {
        throw gone(err, entityKey);
      }
    },
    async patchTrade(entityKey, values) {
      try {
        await wallet().patchEntity(TradeSchema, entityKey, { set: toTradeAttributes(values) });
      } catch (err) {
        throw gone(err, entityKey);
      }
    },
    async extend(entityKey, ttlDays) {
      try {
        return (await wallet().extendEntity({ entityKey, expiration: expiration(ttlDays) })).expiresAt;
      } catch (err) {
        throw gone(err, entityKey);
      }
    },
    async remove(entityKey) {
      try {
        await wallet().deleteEntity({ entityKey });
      } catch (err) {
        if (err instanceof NoEntityFoundError) return;
        throw err;
      }
    },
  };
}
