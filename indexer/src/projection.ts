/**
 * Pure projection of ConsentCraftMarket events into listings and trades. No I/O: given the same
 * ordered logs it always produces the same projection, which is what makes rebuilds and reorg
 * recovery safe.
 */
import { encodeAbiParameters, getAddress, keccak256, parseEventLogs, type Address, type Hex } from "viem";

import { consentCraftMarketAbi } from "../../contracts/abi/ConsentCraftMarket.ts";
import { bytes32ToArweaveTxId } from "../../contracts/lib/arweave-tx-id.ts";
import type { RawLog } from "./source.ts";
import { LISTING_STATUS, REVIEW_STATUS, type ListingProjection, type TradeProjection } from "./types.ts";

/** Stable listing id: one per (chain, contract, publication). */
export function listingId(chainId: number, contract: Address, publicationId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [BigInt(chainId), getAddress(contract), publicationId],
    ),
  );
}

/** Stable trade id: one per (chain, contract, transaction, log index). Reruns map to the same id. */
export function tradeId(chainId: number, contract: Address, txHash: Hex, logIndex: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(chainId), getAddress(contract), txHash, BigInt(logIndex)],
    ),
  );
}

export type Projection = {
  listings: Map<string, ListingProjection>;
  trades: Map<Hex, TradeProjection>;
};

export function emptyProjection(): Projection {
  return { listings: new Map(), trades: new Map() };
}

export type ApplyResult = { dirtyListings: Set<string>; newTrades: TradeProjection[]; events: number };

/** Sorts logs into canonical chain order. */
export function sortLogs(logs: RawLog[]): RawLog[] {
  return [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

/**
 * Applies logs (any order; sorted here) to `projection` in place. Replaying logs that were
 * already applied leaves the projection unchanged (every update is absolute or keyed by id).
 * `timestamps` maps block number to block timestamp and must cover every Purchased log's block.
 */
export function applyLogs(
  projection: Projection,
  logs: RawLog[],
  ctx: { chainId: number; contract: Address; timestamps: Map<bigint, bigint> },
): ApplyResult {
  const result: ApplyResult = { dirtyListings: new Set(), newTrades: [], events: 0 };
  const contract = getAddress(ctx.contract);
  const decoded = parseEventLogs({
    abi: consentCraftMarketAbi,
    logs: sortLogs(logs).filter((l) => getAddress(l.address) === contract) as never,
    strict: true,
  });

  for (const log of decoded) {
    result.events++;
    const block = log.blockNumber as bigint;
    switch (log.eventName) {
      case "PublicationCreated": {
        const a = log.args;
        const id = a.publicationId.toString();
        // Replaying a range after a failed run must not reset a listing already built from it.
        if (projection.listings.has(id)) break;
        projection.listings.set(id, {
          publicationId: a.publicationId,
          author: getAddress(a.author),
          policyId: a.policyId,
          price: a.price,
          pageCount: a.pageCount,
          previewManifestHash: a.previewManifestHash,
          arweavePreviewTxId: bytes32ToArweaveTxId(a.arweavePreviewTxId),
          reviewStatus: "deposited",
          listingStatus: "unlisted",
          totalSales: 0n,
          salesCount: 0,
          sourceTx: log.transactionHash as Hex,
          sourceBlock: block,
          lastEventBlock: block,
        });
        result.dirtyListings.add(id);
        break;
      }
      case "ReviewStatusChanged": {
        const l = mustListing(projection, log.args.publicationId);
        l.reviewStatus = REVIEW_STATUS[log.args.newState];
        l.lastEventBlock = block;
        result.dirtyListings.add(l.publicationId.toString());
        break;
      }
      case "PublicationPublished": {
        const l = mustListing(projection, log.args.publicationId);
        l.listingStatus = LISTING_STATUS[1];
        l.lastEventBlock = block;
        result.dirtyListings.add(l.publicationId.toString());
        break;
      }
      case "PublicationDelisted": {
        const l = mustListing(projection, log.args.publicationId);
        l.listingStatus = LISTING_STATUS[2];
        l.lastEventBlock = block;
        result.dirtyListings.add(l.publicationId.toString());
        break;
      }
      case "Purchased": {
        const a = log.args;
        const l = mustListing(projection, a.publicationId);
        l.totalSales = a.cumulativeGrossSales;
        l.lastEventBlock = block;
        result.dirtyListings.add(l.publicationId.toString());

        const timestamp = ctx.timestamps.get(block);
        if (timestamp === undefined) throw new Error(`Missing timestamp for block ${block}`);
        const id = tradeId(ctx.chainId, contract, log.transactionHash as Hex, log.logIndex as number);
        if (!projection.trades.has(id)) {
          const trade: TradeProjection = {
            tradeId: id,
            listingId: listingId(ctx.chainId, contract, a.publicationId),
            publicationId: a.publicationId,
            buyer: getAddress(a.buyer),
            price: a.price,
            platformFee: a.platformFee,
            authorProceeds: a.authorProceeds,
            cumulativeSales: a.cumulativeGrossSales,
            blockNumber: block,
            timestamp,
            txHash: log.transactionHash as Hex,
            logIndex: log.logIndex as number,
          };
          projection.trades.set(id, trade);
          result.newTrades.push(trade);
        }
        // Derived, not incremented: exact no matter how often a range is replayed.
        l.salesCount = countTrades(projection, a.publicationId);
        break;
      }
      default:
        // Other events (credits, settlements, roles, appeals) carry nothing the public listing
        // or trade entities need beyond the review state already handled above.
        break;
    }
  }
  return result;
}

/** Blocks whose timestamps applyLogs will need. */
export function purchaseBlocks(logs: RawLog[], contract: Address): bigint[] {
  const decoded = parseEventLogs({
    abi: consentCraftMarketAbi,
    eventName: "Purchased",
    logs: logs.filter((l) => getAddress(l.address) === getAddress(contract)) as never,
  });
  return [...new Set(decoded.map((l) => l.blockNumber as bigint))];
}

function countTrades(projection: Projection, publicationId: bigint): number {
  let n = 0;
  for (const t of projection.trades.values()) if (t.publicationId === publicationId) n++;
  return n;
}

function mustListing(projection: Projection, publicationId: bigint): ListingProjection {
  const l = projection.listings.get(publicationId.toString());
  if (!l) {
    throw new Error(
      `Event for publication ${publicationId} before its PublicationCreated; startBlock is probably later than the contract's first publication`,
    );
  }
  return l;
}
