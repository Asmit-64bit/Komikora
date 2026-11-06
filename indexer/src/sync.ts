/**
 * The indexer engine.
 *
 * - Only blocks at least `confirmations` deep are indexed.
 * - The hash of the last processed block is remembered. If the source chain no longer has that
 *   hash, a reorganization happened and the projection is rebuilt from contract events, then
 *   reconciled with Arkiv (missing entities created, changed ones patched, orphaned ones deleted).
 * - Every write is idempotent: entities are identified by listingId / tradeId (derived from chain
 *   ID, contract, and for trades the transaction hash and log index), and Arkiv is searched before
 *   anything is created. Entity keys are saved as soon as a write succeeds.
 * - The checkpoint advances only after every write for a block range succeeded, so a failed run is
 *   retried from the same range on the next run without duplicating anything.
 */
import { getAddress, type Hex } from "viem";

import { buildListingValues, buildTradeValues } from "./entities.ts";
import { loadPreviewMetadata, needsMetadataFetch, type ManifestFetcher } from "./metadata.ts";
import { applyLogs, emptyProjection, purchaseBlocks, type Projection } from "./projection.ts";
import type { SourceChain } from "./source.ts";
import type { StateStore } from "./state.ts";
import { EntityGoneError, type EntityStore, type StoredEntity } from "./store.ts";
import type { IndexerConfig, IndexerState, ListingProjection, Logger, TradeProjection } from "./types.ts";

export type IndexerContext = {
  source: SourceChain;
  store: EntityStore;
  fetcher: ManifestFetcher;
  stateStore: StateStore;
  config: IndexerConfig;
  log: Logger;
  now?: () => Date;
};

export type SyncReport = {
  mode: "incremental" | "rebuild" | "idle";
  reorg: boolean;
  fromBlock?: bigint;
  toBlock?: bigint;
  events: number;
  tradesCreated: number;
  listingsCreated: number;
  listingsPatched: number;
  tradesPatched: number;
  deleted: number;
};

const now = (ctx: IndexerContext) => (ctx.now ? ctx.now() : new Date());

export async function withRetry<T>(label: string, ctx: IndexerContext, fn: () => Promise<T>): Promise<T> {
  const { attempts, baseDelayMs } = ctx.config.retry;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EntityGoneError) throw err; // not transient; caller handles
      lastErr = err;
      ctx.log(`retry ${label}`, { attempt: i + 1, of: attempts, error: String((err as Error).message ?? err) });
      if (i + 1 < attempts && baseDelayMs > 0) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

function freshState(config: IndexerConfig, metadata: IndexerState["metadata"] = {}): IndexerState {
  return {
    version: 1,
    chainId: config.chainId,
    contract: getAddress(config.contract),
    startBlock: config.startBlock,
    lastProcessedBlock: config.startBlock - 1n,
    lastProcessedHash: null,
    listings: {},
    trades: {},
    metadata,
    updatedAt: new Date(0).toISOString(),
  };
}

async function loadState(ctx: IndexerContext): Promise<IndexerState> {
  const s = await ctx.stateStore.load();
  if (!s) return freshState(ctx.config);
  if (s.chainId !== ctx.config.chainId || getAddress(s.contract) !== getAddress(ctx.config.contract)) {
    throw new Error(`State belongs to chain ${s.chainId} / ${s.contract}, not the configured market`);
  }
  return s;
}

async function save(ctx: IndexerContext, state: IndexerState) {
  state.updatedAt = now(ctx).toISOString();
  await ctx.stateStore.save(state);
}

function projectionOf(state: IndexerState): Projection {
  const p = emptyProjection();
  for (const [id, r] of Object.entries(state.listings)) p.listings.set(id, { ...r.projection });
  for (const [id, r] of Object.entries(state.trades)) p.trades.set(id as Hex, { ...r.projection });
  return p;
}

async function safeHead(ctx: IndexerContext) {
  const head = await ctx.source.headBlockNumber();
  return head - BigInt(ctx.config.confirmations);
}

/** Fetches and folds logs for [from, to] in batches. */
async function foldRange(ctx: IndexerContext, projection: Projection, from: bigint, to: bigint) {
  const dirty = new Set<string>();
  const trades: TradeProjection[] = [];
  let events = 0;
  for (let a = from; a <= to; a += BigInt(ctx.config.batchBlocks)) {
    const b = a + BigInt(ctx.config.batchBlocks) - 1n < to ? a + BigInt(ctx.config.batchBlocks) - 1n : to;
    const logs = await withRetry(`getLogs ${a}-${b}`, ctx, () => ctx.source.getLogs(ctx.config.contract, a, b));
    const timestamps = new Map<bigint, bigint>();
    for (const n of purchaseBlocks(logs, ctx.config.contract)) {
      timestamps.set(n, (await withRetry(`getBlock ${n}`, ctx, () => ctx.source.getBlock(n))).timestamp);
    }
    const r = applyLogs(projection, logs, { chainId: ctx.config.chainId, contract: ctx.config.contract, timestamps });
    r.dirtyListings.forEach((id) => dirty.add(id));
    trades.push(...r.newTrades);
    events += r.events;
  }
  return { dirty, trades, events };
}

async function refreshMetadata(ctx: IndexerContext, state: IndexerState, listings: Iterable<ListingProjection>) {
  for (const l of listings) {
    const previous = state.metadata[l.previewManifestHash];
    if (!needsMetadataFetch(previous, now(ctx))) continue;
    state.metadata[l.previewManifestHash] = await loadPreviewMetadata(ctx.fetcher, l.arweavePreviewTxId, l.previewManifestHash, {
      now: now(ctx),
      retryMs: ctx.config.metadataRetryMs,
      maxAttempts: ctx.config.metadataMaxAttempts,
      ...(previous && { previous }),
    });
    ctx.log("preview metadata", { publicationId: l.publicationId.toString(), status: state.metadata[l.previewManifestHash].status });
  }
}

/** Listings whose metadata fetch failed transiently and is due for another attempt. */
function metadataRetryDue(ctx: IndexerContext, state: IndexerState): string[] {
  return Object.entries(state.listings)
    .filter(([, r]) => {
      const m = state.metadata[r.projection.previewManifestHash];
      return m?.status === "unavailable" && needsMetadataFetch(m, now(ctx));
    })
    .map(([id]) => id);
}

type Counters = Omit<SyncReport, "mode" | "reorg" | "fromBlock" | "toBlock" | "events">;
const zero = (): Counters => ({ tradesCreated: 0, listingsCreated: 0, listingsPatched: 0, tradesPatched: 0, deleted: 0 });

async function ensureTrade(ctx: IndexerContext, state: IndexerState, t: TradeProjection, known: StoredEntity | null | undefined, c: Counters) {
  const values = buildTradeValues(ctx.config.chainId, ctx.config.contract, t);
  const rec = (state.trades[t.tradeId] ??= { projection: t });
  rec.projection = t;
  if (rec.entityKey && rec.contentHash === values.contentHash) return;
  const existing = known !== undefined ? known : await withRetry(`find trade ${t.tradeId}`, ctx, () => ctx.store.findById("trade", t.tradeId));
  if (existing) {
    rec.entityKey = existing.entityKey;
    rec.expiresAt = existing.expiresAt;
    if (existing.contentHash !== values.contentHash) {
      await withRetry(`patch trade ${t.tradeId}`, ctx, () => ctx.store.patchTrade(existing.entityKey, values));
      c.tradesPatched++;
    }
  } else {
    const w = await withRetry(`create trade ${t.tradeId}`, ctx, () => ctx.store.createTrade(values, ctx.config.ttlDays));
    rec.entityKey = w.entityKey;
    rec.expiresAt = w.expiresAt;
    c.tradesCreated++;
  }
  rec.contentHash = values.contentHash;
  await save(ctx, state);
}

async function upsertListing(ctx: IndexerContext, state: IndexerState, id: string, known: StoredEntity | null | undefined, c: Counters) {
  const projection = state.listings[id].projection;
  const values = buildListingValues(ctx.config.chainId, ctx.config.contract, projection, state.metadata[projection.previewManifestHash]);
  const rec = state.listings[id];
  if (rec.entityKey && rec.contentHash === values.contentHash) return;

  let target = rec.entityKey ? { entityKey: rec.entityKey, contentHash: rec.contentHash } : null;
  if (!target) {
    const existing = known !== undefined ? known : await withRetry(`find listing ${id}`, ctx, () => ctx.store.findById("listing", values.listingId));
    if (existing) {
      rec.entityKey = existing.entityKey;
      rec.expiresAt = existing.expiresAt;
      target = existing;
    }
  }
  if (target && target.contentHash === values.contentHash) {
    rec.contentHash = values.contentHash;
  } else if (target) {
    try {
      await withRetry(`patch listing ${id}`, ctx, () => ctx.store.patchListing(target.entityKey, values));
      c.listingsPatched++;
    } catch (err) {
      if (!(err instanceof EntityGoneError)) throw err;
      // Expired or deleted on Arkiv: recreate from the projection.
      const w = await withRetry(`recreate listing ${id}`, ctx, () => ctx.store.createListing(values, ctx.config.ttlDays));
      rec.entityKey = w.entityKey;
      rec.expiresAt = w.expiresAt;
      c.listingsCreated++;
    }
  } else {
    const w = await withRetry(`create listing ${id}`, ctx, () => ctx.store.createListing(values, ctx.config.ttlDays));
    rec.entityKey = w.entityKey;
    rec.expiresAt = w.expiresAt;
    c.listingsCreated++;
  }
  rec.contentHash = values.contentHash;
  await save(ctx, state);
}

/** One incremental step: index every newly confirmed block, or rebuild after a reorg. */
export async function syncOnce(ctx: IndexerContext): Promise<SyncReport> {
  const state = await loadState(ctx);
  const safe = await safeHead(ctx);

  // Reorg check: does the chain still have the block we last indexed?
  if (state.lastProcessedHash) {
    const current = await withRetry("getBlock checkpoint", ctx, () => ctx.source.getBlock(state.lastProcessedBlock));
    if (current.hash !== state.lastProcessedHash) {
      ctx.log("reorg detected; rebuilding from contract events", {
        block: state.lastProcessedBlock.toString(),
        expected: state.lastProcessedHash,
        actual: current.hash,
      });
      return { ...(await rebuild(ctx)), reorg: true };
    }
  }

  const from = state.lastProcessedBlock + 1n;
  const retryIds = metadataRetryDue(ctx, state);
  if (safe < from && retryIds.length === 0) {
    return { mode: "idle", reorg: false, events: 0, ...zero() };
  }

  const projection = projectionOf(state);
  const to = safe;
  const folded = safe >= from ? await foldRange(ctx, projection, from, to) : { dirty: new Set<string>(), trades: [], events: 0 };
  retryIds.forEach((id) => folded.dirty.add(id));

  for (const id of folded.dirty) {
    const p = projection.listings.get(id)!;
    const rec = (state.listings[id] ??= { projection: p });
    rec.projection = p;
  }
  await refreshMetadata(ctx, state, [...folded.dirty].map((id) => state.listings[id].projection));

  const c = zero();
  for (const t of folded.trades) await ensureTrade(ctx, state, t, undefined, c);
  for (const id of folded.dirty) await upsertListing(ctx, state, id, undefined, c);

  if (safe >= from) {
    const checkpoint = await withRetry(`getBlock ${to}`, ctx, () => ctx.source.getBlock(to));
    state.lastProcessedBlock = to;
    state.lastProcessedHash = checkpoint.hash;
    await save(ctx, state);
  }
  return { mode: "incremental", reorg: false, fromBlock: from, toBlock: to, events: folded.events, ...c };
}

/**
 * Rebuilds everything from contract events (startBlock to the confirmed head), then makes Arkiv
 * match: creates what is missing, patches what changed, deletes what no longer exists.
 */
export async function rebuild(ctx: IndexerContext): Promise<SyncReport> {
  const previous = await ctx.stateStore.load();
  // Verified metadata is keyed by content hash and immutable; keep it. Retry everything else.
  const keptMetadata = Object.fromEntries(Object.entries(previous?.metadata ?? {}).filter(([, m]) => m.status === "verified"));
  const state = freshState(ctx.config, keptMetadata);
  const safe = await safeHead(ctx);
  const projection = emptyProjection();
  const folded = safe >= state.startBlock ? await foldRange(ctx, projection, state.startBlock, safe) : { events: 0 };

  for (const [id, p] of projection.listings) state.listings[id] = { projection: p };
  await refreshMetadata(ctx, state, projection.listings.values());

  const [ownedListings, ownedTrades] = await Promise.all([
    withRetry("list listings", ctx, () => ctx.store.listOwned("listing", ctx.config.chainId, ctx.config.contract)),
    withRetry("list trades", ctx, () => ctx.store.listOwned("trade", ctx.config.chainId, ctx.config.contract)),
  ]);
  const listingById = new Map(ownedListings.map((e) => [e.id, e]));
  const tradeById = new Map(ownedTrades.map((e) => [e.id, e]));

  const c = zero();
  for (const t of projection.trades.values()) {
    await ensureTrade(ctx, state, t, tradeById.get(t.tradeId) ?? null, c);
    tradeById.delete(t.tradeId);
  }
  for (const [id, p] of projection.listings) {
    const lid = buildListingValues(ctx.config.chainId, ctx.config.contract, p, undefined).listingId;
    await upsertListing(ctx, state, id, listingById.get(lid) ?? null, c);
    listingById.delete(lid);
  }
  // Whatever is left was written for events that are no longer canonical (reorged away).
  for (const orphan of [...tradeById.values(), ...listingById.values()]) {
    await withRetry(`delete orphan ${orphan.entityKey}`, ctx, () => ctx.store.remove(orphan.entityKey));
    c.deleted++;
  }

  if (safe >= state.startBlock) {
    state.lastProcessedBlock = safe;
    state.lastProcessedHash = (await withRetry(`getBlock ${safe}`, ctx, () => ctx.source.getBlock(safe))).hash;
  }
  await save(ctx, state);
  return { mode: "rebuild", reorg: false, fromBlock: state.startBlock, toBlock: safe, events: folded.events, ...c };
}

export type RenewReport = { checked: number; extended: number; recreated: number; skippedInactive: number };

/**
 * Keeps Arkiv entities alive: extends listings and trades that expire within `renewBeforeDays`, and
 * recreates any that already expired (for example after an outage). Rejected listings are left to
 * expire. Expiry on Arkiv never affects ownership or reading access; the contract is the authority.
 */
export async function renew(ctx: IndexerContext): Promise<RenewReport> {
  let state = await ctx.stateStore.load();
  if (!state) {
    await rebuild(ctx);
    state = (await ctx.stateStore.load())!;
  }
  const arkivBlock = await ctx.store.blockNumber();
  const threshold = arkivBlock + BigInt(ctx.config.renewBeforeDays * ctx.store.blocksPerDay());
  const [ownedListings, ownedTrades] = await Promise.all([
    ctx.store.listOwned("listing", ctx.config.chainId, ctx.config.contract),
    ctx.store.listOwned("trade", ctx.config.chainId, ctx.config.contract),
  ]);
  const byKey = new Map([...ownedListings, ...ownedTrades].map((e) => [e.entityKey, e]));
  const report: RenewReport = { checked: 0, extended: 0, recreated: 0, skippedInactive: 0 };

  const c = zero();
  for (const [id, rec] of Object.entries(state.listings)) {
    if (rec.projection.reviewStatus === "rejected") {
      report.skippedInactive++;
      continue;
    }
    report.checked++;
    const live = rec.entityKey ? byKey.get(rec.entityKey) : undefined;
    if (!live) {
      rec.entityKey = undefined;
      rec.contentHash = undefined;
      await upsertListing(ctx, state, id, null, c);
      report.recreated++;
    } else if (live.expiresAt < threshold) {
      rec.expiresAt = await withRetry(`extend listing ${id}`, ctx, () => ctx.store.extend(live.entityKey, ctx.config.ttlDays));
      report.extended++;
      await save(ctx, state);
    }
  }
  for (const [id, rec] of Object.entries(state.trades)) {
    report.checked++;
    const live = rec.entityKey ? byKey.get(rec.entityKey) : undefined;
    if (!live) {
      rec.entityKey = undefined;
      rec.contentHash = undefined;
      await ensureTrade(ctx, state, rec.projection, null, c);
      report.recreated++;
    } else if (live.expiresAt < threshold) {
      rec.expiresAt = await withRetry(`extend trade ${id}`, ctx, () => ctx.store.extend(live.entityKey, ctx.config.ttlDays));
      report.extended++;
      await save(ctx, state);
    }
  }
  return report;
}
