/**
 * ConsentCraft Arkiv indexer CLI.
 *
 *   npm run indexer -- backfill [--rebuild] [--dry-run]   index every confirmed block up to the safe head
 *   npm run indexer -- watch                              keep indexing; renew periodically
 *   npm run indexer -- renew                              extend or recreate entities near expiry
 *   npm run indexer -- status                             show the saved checkpoint
 *   npm run indexer -- listings [--genre g] [--language l] [--author 0x] [--min-price wei] [--max-price wei]
 *                                [--review s] [--listing s|any] [--unverified] [--limit n] [--writer 0x]
 *   npm run indexer -- trades [--publication id] [--limit n] [--writer 0x]
 *
 * `listings` and `trades` are read-only and need no private key.
 */
import { parseArgs } from "node:util";
import type { Address } from "viem";

import { arkivPublicClient, createArkivStore } from "./arkiv-store.ts";
import { loadConfig } from "./config.ts";
import { MemoryEntityStore } from "./memory-store.ts";
import { gatewayFetcher } from "./metadata.ts";
import { recentTrades, searchListings } from "./read.ts";
import { viemSource } from "./source.ts";
import { FileStateStore, MemoryStateStore } from "./state.ts";
import { rebuild, renew, syncOnce, type IndexerContext } from "./sync.ts";
import type { ListingStatus, ReviewStatus } from "./types.ts";

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    rebuild: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    genre: { type: "string" },
    language: { type: "string" },
    author: { type: "string" },
    "min-price": { type: "string" },
    "max-price": { type: "string" },
    review: { type: "string" },
    listing: { type: "string" },
    unverified: { type: "boolean", default: false },
    publication: { type: "string" },
    limit: { type: "string" },
    writer: { type: "string" },
  },
});
const command = positionals[0];

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const log = (message: string, data?: Record<string, unknown>) =>
  console.log(`${new Date().toISOString()} ${message}${data ? ` ${json(data).replace(/\s+/g, " ")}` : ""}`);

async function main() {
  const cfg = loadConfig();

  if (command === "listings" || command === "trades") {
    const writer = (flags.writer ?? cfg.writer) as Address | undefined;
    if (!writer) throw new Error("Pass --writer 0x... (the indexer wallet) or set ARKIV_WRITER_ADDRESS");
    const client = arkivPublicClient(cfg.arkivAccessKey);
    const scope = { writer, chainId: cfg.indexer.chainId, contract: cfg.indexer.contract };
    const limit = flags.limit ? Number(flags.limit) : 20;
    if (command === "listings") {
      const r = await searchListings(client, {
        ...scope,
        limit,
        ...(flags.genre && { genre: flags.genre }),
        ...(flags.language && { language: flags.language }),
        ...(flags.author && { author: flags.author as Address }),
        ...(flags["min-price"] && { minPrice: BigInt(flags["min-price"]) }),
        ...(flags["max-price"] && { maxPrice: BigInt(flags["max-price"]) }),
        ...(flags.review && { reviewStatus: flags.review as ReviewStatus }),
        ...(flags.listing && { listingStatus: flags.listing as ListingStatus | "any" }),
        includeUnverified: flags.unverified,
      });
      console.log(json(r));
    } else {
      console.log(json(await recentTrades(client, { ...scope, limit, ...(flags.publication && { publicationId: BigInt(flags.publication) }) })));
    }
    return;
  }

  if (!cfg.sourceRpcUrl) throw new Error("Set INDEXER_SOURCE_RPC_URL (Sepolia RPC) to read contract events");
  const source = viemSource(cfg.sourceRpcUrl);
  const actualChain = await source.chainId();
  if (actualChain !== cfg.indexer.chainId) throw new Error(`Source RPC is chain ${actualChain}, expected ${cfg.indexer.chainId}`);

  const dryRun = flags["dry-run"];
  if (!dryRun && !cfg.arkivPrivateKey) throw new Error("Set ARKIV_PRIVATE_KEY (funded Rabdi wallet) or use --dry-run");
  const store = dryRun
    ? new MemoryEntityStore()
    : createArkivStore({ accessKey: cfg.arkivAccessKey, privateKey: cfg.arkivPrivateKey! });
  const ctx: IndexerContext = {
    source,
    store,
    fetcher: gatewayFetcher(cfg.arweaveGateway),
    stateStore: dryRun ? new MemoryStateStore() : new FileStateStore(cfg.statePath),
    config: cfg.indexer,
    log,
  };
  log("indexer", {
    command,
    dryRun,
    writer: store.owner,
    chainId: cfg.indexer.chainId,
    contract: cfg.indexer.contract,
    confirmations: cfg.indexer.confirmations,
    state: dryRun ? "memory" : cfg.statePath,
  });

  switch (command) {
    case "backfill": {
      if (flags.rebuild) log("rebuild", await rebuild(ctx));
      for (;;) {
        const r = await syncOnce(ctx);
        log("sync", r);
        if (r.mode === "idle" || r.mode === "rebuild") break;
      }
      if (dryRun) log("dry-run entities", { listings: (store as MemoryEntityStore).live("listing").length, trades: (store as MemoryEntityStore).live("trade").length });
      return;
    }
    case "watch": {
      let lastRenew = 0;
      let failures = 0;
      for (;;) {
        try {
          const r = await syncOnce(ctx);
          if (r.mode !== "idle") log("sync", r);
          if (Date.now() - lastRenew > cfg.renewEveryMs) {
            log("renew", await renew(ctx));
            lastRenew = Date.now();
          }
          failures = 0;
        } catch (err) {
          failures++;
          log("error; will retry", { failures, error: String((err as Error).message ?? err) });
        }
        await new Promise((r) => setTimeout(r, Math.min(cfg.pollMs * 2 ** Math.min(failures, 5), 10 * 60_000)));
      }
    }
    case "renew":
      log("renew", await renew(ctx));
      return;
    case "status": {
      const s = await ctx.stateStore.load();
      log("status", s ? { lastProcessedBlock: s.lastProcessedBlock, listings: Object.keys(s.listings).length, trades: Object.keys(s.trades).length, updatedAt: s.updatedAt } : { state: "none" });
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ""}". Use backfill, watch, renew, status, listings or trades.`);
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message ?? err}`);
  process.exitCode = 1;
});
