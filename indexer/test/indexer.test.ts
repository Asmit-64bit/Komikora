import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { getAddress, http, keccak256, parseEther, toBytes, toHex, type Hex } from "viem";

import { bytes32ToArweaveTxId } from "../../contracts/lib/arweave-tx-id.ts";
import type { ListingValues, TradeValues } from "../src/entities.ts";
import { loadPreviewMetadata, truncateUtf8 } from "../src/metadata.ts";
import { applyLogs, emptyProjection, listingId, tradeId } from "../src/projection.ts";
import { buildListingQuery, buildTradeQuery, listingFilters } from "../src/read.ts";
import { rebuild, renew, syncOnce } from "../src/sync.ts";
import { PURCHASED_TOPIC, fixture, makeContext } from "./support.ts";

const A = fixture.expected.publications.verifiedA;
const B = fixture.expected.publications.mismatchB;
const C = fixture.expected.publications.delistedC;

const listingsOf = (store: ReturnType<typeof makeContext>["store"]) =>
  new Map(store.live("listing").map((r) => [(r.values as ListingValues).publicationId.toString(), r.values as ListingValues]));
const tradesOf = (store: ReturnType<typeof makeContext>["store"]) => store.live("trade").map((r) => r.values as TradeValues);

describe("projection", () => {
  it("is deterministic and replaying the same logs changes nothing", async () => {
    const { source } = makeContext();
    const logs = await source.getLogs(fixture.contract, 0n, source.head);
    const timestamps = new Map([...source.blocks.values()].map((b) => [b.number, b.timestamp]));
    const ctx = { chainId: fixture.chainId, contract: fixture.contract, timestamps };
    const p = emptyProjection();
    applyLogs(p, logs, ctx);
    const snapshot = JSON.stringify([...p.listings, ...p.trades], (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const again = applyLogs(p, logs, ctx);
    assert.equal(again.newTrades.length, 0);
    assert.equal(JSON.stringify([...p.listings, ...p.trades], (_, v) => (typeof v === "bigint" ? v.toString() : v)), snapshot);
  });

  it("derives ids from chain, contract, publication / tx hash and log index", () => {
    const a = tradeId(1, fixture.contract, `0x${"11".repeat(32)}`, 3);
    assert.equal(a, tradeId(1, fixture.contract.toLowerCase() as Hex, `0x${"11".repeat(32)}`, 3));
    assert.notEqual(a, tradeId(1, fixture.contract, `0x${"11".repeat(32)}`, 4));
    assert.notEqual(a, tradeId(2, fixture.contract, `0x${"11".repeat(32)}`, 3));
    assert.notEqual(listingId(1, fixture.contract, 1n), listingId(1, fixture.contract, 2n));
  });
});

describe("backfill from recorded contract events", () => {
  it("projects listings and trades with verified metadata only", async () => {
    const { ctx, store } = makeContext();
    const r = await syncOnce(ctx);
    assert.equal(r.mode, "incremental");
    assert.equal(r.tradesCreated, fixture.expected.tradeCount);
    assert.equal(r.listingsCreated, 3);

    const listings = listingsOf(store);
    const a = listings.get(A)!;
    assert.equal(a.metadataStatus, "verified");
    assert.equal(a.title, "Moonlit Couriers");
    assert.equal(a.genre, "fantasy");
    assert.equal(a.language, "en");
    assert.match(a.previewRef ?? "", /^ar:\/\/[A-Za-z0-9_-]{43}$/);
    assert.equal(a.reviewStatus, "published");
    assert.equal(a.listingStatus, "listed");
    assert.equal(a.totalSales, parseEther("0.03"));
    assert.equal(a.salesCount, 3n);
    assert.equal(a.price, parseEther("0.01"));
    assert.equal(a.schemaVersion, 1n);
    assert.equal(a.chainId, BigInt(fixture.chainId));

    const b = listings.get(B)!;
    assert.equal(b.metadataStatus, "unavailable");
    assert.equal(b.title, undefined, "unverified title must not be indexed");
    assert.equal(b.genre, undefined);
    assert.equal(b.language, undefined);
    assert.equal(b.reviewStatus, "rejected");
    assert.equal(b.listingStatus, "unlisted");

    const c = listingsOf(store).get(C)!;
    assert.equal(c.listingStatus, "delisted");
    assert.equal(c.reviewStatus, "published");
    assert.equal(c.salesCount, 1n);
    assert.equal(c.genre, "science fiction");
    assert.equal(c.previewRef, undefined, "manifest without preview images has no preview reference");

    const trades = tradesOf(store);
    assert.equal(trades.length, 4);
    for (const t of trades) {
      const block = fixture.blocks[t.blockNumber.toString()];
      assert.equal(t.timestamp, BigInt(block.timestamp));
      assert.equal(t.platformFee + t.authorProceeds, t.price);
      assert.equal(t.feedOrder, t.blockNumber * 1_000_000n + t.logIndex);
      assert.equal(t.tradeId, tradeId(fixture.chainId, fixture.contract, t.txHash, Number(t.logIndex)));
    }
    assert.deepEqual(
      trades.filter((t) => t.publicationId.toString() === A).map((t) => t.cumulativeSales).sort(),
      [parseEther("0.01"), parseEther("0.02"), parseEther("0.03")],
    );
  });

  it("never writes the encrypted bundle's Arweave ID or any private field", async () => {
    const { ctx, store } = makeContext();
    await syncOnce(ctx);
    const written = JSON.stringify([...store.rows.values()].map((r) => r.values), (_, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const label of ["comic A", "comic B", "comic C"]) {
      // The recorder derived bundle IDs from this label; neither form may appear anywhere.
      const bundle = keccak256(toHex(`INDEXER TEST FIXTURE - not a real Arweave tx - ${label} bundle`));
      assert.ok(!written.includes(bundle.slice(2)), `bundle id hex for ${label} leaked`);
      assert.ok(!written.includes(bytes32ToArweaveTxId(bundle)), `bundle id for ${label} leaked`);
    }
    const allowed = new Set([
      "listingId", "chainId", "contract", "publicationId", "author", "title", "genre", "language", "price", "pageCount",
      "previewRef", "arweavePreviewTxId", "previewManifestHash", "metadataStatus", "reviewStatus", "listingStatus",
      "totalSales", "salesCount", "policyId", "sourceTx", "sourceBlock", "lastEventBlock", "contentHash", "schemaVersion",
    ]);
    for (const r of store.live("listing")) for (const k of Object.keys(r.values)) assert.ok(allowed.has(k), `unexpected listing field ${k}`);
  });

  it("indexes only blocks with enough confirmations", async () => {
    const { ctx, source, store } = makeContext({ confirmations: 6 });
    const head = source.head;
    const r1 = await syncOnce(ctx);
    assert.equal(r1.toBlock, head - 6n);
    const early = tradesOf(store).length;
    assert.ok(early < fixture.expected.tradeCount, "late trades are not yet confirmed");
    for (const t of tradesOf(store)) assert.ok(t.blockNumber <= head - 6n);

    source.mine(6);
    const r2 = await syncOnce(ctx);
    assert.equal(r2.toBlock, head);
    assert.equal(tradesOf(store).length, fixture.expected.tradeCount);
    assert.equal((await syncOnce(ctx)).mode, "idle");
  });
});

describe("idempotency", () => {
  it("reruns and duplicate log deliveries never duplicate trades", async () => {
    const { ctx, store } = makeContext();
    await syncOnce(ctx);
    const writes = store.writes.length;
    assert.equal((await syncOnce(ctx)).mode, "idle");
    assert.equal(store.writes.length, writes);

    // Same logs delivered twice in one response, on a fresh run.
    const second = makeContext();
    second.source.duplicateLogs = true;
    await syncOnce(second.ctx);
    assert.equal(tradesOf(second.store).length, fixture.expected.tradeCount);
    assert.equal(listingsOf(second.store).get(A)!.salesCount, 3n);
  });

  it("a lost state file is recovered from Arkiv without duplicates", async () => {
    const { ctx, store, stateStore } = makeContext();
    await syncOnce(ctx);
    const before = store.rows.size;
    stateStore.text = null; // state lost
    const r = await syncOnce(ctx);
    assert.equal(r.tradesCreated, 0);
    assert.equal(r.listingsCreated, 0);
    assert.equal(store.rows.size, before);
  });
});

describe("preview manifest verification", () => {
  it("marks a manifest whose bytes do not match previewManifestHash unavailable and uses none of it", async () => {
    const { ctx, store, fetcher } = makeContext();
    await syncOnce(ctx);
    const b = listingsOf(store).get(B)!;
    assert.equal(b.metadataStatus, "unavailable");
    // The served bytes really did contain a title; it must not leak through.
    const served = Buffer.from(fixture.manifests[b.arweavePreviewTxId], "base64").toString();
    assert.match(served, /tampered/);
    assert.ok(!JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes("Paper Lanterns"));
    // Permanent: not fetched again on later runs.
    const calls = fetcher.calls.filter((c) => c === b.arweavePreviewTxId).length;
    await syncOnce(ctx);
    assert.equal(fetcher.calls.filter((c) => c === b.arweavePreviewTxId).length, calls);
  });

  it("rejects a gateway serving different bytes for a verified listing", async () => {
    const { ctx, store, fetcher } = makeContext();
    const aPreview = bytes32ToArweaveTxId(listingsPreview(A));
    fetcher.overrides.set(aPreview, toBytes('{"schema":"consentcraft.preview.v1","title":"Evil","language":"en","genre":"x"}'));
    await syncOnce(ctx);
    const a = listingsOf(store).get(A)!;
    assert.equal(a.metadataStatus, "unavailable");
    assert.equal(a.title, undefined);
  });

  it("retries a failed fetch later and then fills in verified metadata", async () => {
    const { ctx, store, fetcher, advanceClock } = makeContext();
    const aPreview = bytes32ToArweaveTxId(listingsPreview(A));
    fetcher.failing.add(aPreview);
    await syncOnce(ctx);
    assert.equal(listingsOf(store).get(A)!.metadataStatus, "unavailable");

    fetcher.failing.delete(aPreview);
    assert.equal((await syncOnce(ctx)).mode, "idle", "not retried before nextAttemptAt");
    advanceClock(61_000);
    const r = await syncOnce(ctx);
    assert.equal(r.listingsPatched, 1);
    const a = listingsOf(store).get(A)!;
    assert.equal(a.metadataStatus, "verified");
    assert.equal(a.title, "Moonlit Couriers");
  });

  it("validates manifest shape only after the hash matches, and truncates long titles to 128 bytes", async () => {
    const bytes = toBytes(JSON.stringify({ schema: "consentcraft.preview.v1", title: "é".repeat(200), language: "EN", genre: "Horror", previewImages: ["https://x"] }));
    const r = await loadPreviewMetadata({ fetch: async () => bytes }, "x", keccak256(bytes), { now: new Date(), retryMs: 1, maxAttempts: 3 });
    assert.equal(r.status, "verified");
    if (r.status === "verified") {
      assert.ok(new TextEncoder().encode(r.metadata.title).length <= 128);
      assert.equal(r.metadata.titleTruncated, true);
      assert.equal(r.metadata.language, "en");
      assert.equal(r.metadata.previewRef, undefined, "only ar:// references are kept");
    }
    const bad = toBytes('{"schema":"other"}');
    const r2 = await loadPreviewMetadata({ fetch: async () => bad }, "x", keccak256(bad), { now: new Date(), retryMs: 1, maxAttempts: 3 });
    assert.deepEqual([r2.status, r2.status === "unavailable" && r2.reason], ["unavailable", "invalid_manifest"]);
    assert.deepEqual(truncateUtf8("short", 128), { text: "short", truncated: false });
  });
});

describe("reorganizations", () => {
  it("drops a trade that was reorganized away and corrects the listing", async () => {
    const { ctx, source, store, logs } = makeContext();
    await syncOnce(ctx);
    const aTrades = tradesOf(store).filter((t) => t.publicationId.toString() === A).sort((x, y) => Number(x.feedOrder - y.feedOrder));
    const lastA = aTrades.at(-1)!;

    // The block holding A's third purchase is replaced by a branch without it.
    source.reorg(lastA.blockNumber, (l) => !(l.transactionHash === lastA.txHash));
    const r = await syncOnce(ctx);
    assert.equal(r.reorg, true);
    assert.ok(logs.some((m) => m.startsWith("reorg detected")));
    assert.ok(r.deleted >= 1);

    const trades = tradesOf(store);
    assert.ok(!trades.some((t) => t.tradeId === lastA.tradeId));
    const a = listingsOf(store).get(A)!;
    assert.equal(a.salesCount, 2n);
    assert.equal(a.totalSales, parseEther("0.02"));
    assert.equal(store.live("trade").length, fixture.expected.tradeCount - 1);
  });

  it("re-includes a reorganized purchase under its new block and log index without duplicates", async () => {
    const { ctx, source, store } = makeContext();
    await syncOnce(ctx);
    const target = tradesOf(store).sort((x, y) => Number(x.feedOrder - y.feedOrder))[0];
    const moved = source.logs.filter((l) => l.transactionHash === target.txHash);
    source.reorg(target.blockNumber, (l) => l.transactionHash !== target.txHash);
    source.mine(1);
    const newBlock = source.blocks.get(source.head)!;
    source.logs.push(...moved.map((l, i) => ({ ...l, blockNumber: newBlock.number, blockHash: newBlock.hash, logIndex: 50 + i })));

    await syncOnce(ctx);
    const trades = tradesOf(store);
    assert.equal(trades.length, fixture.expected.tradeCount);
    assert.ok(!trades.some((t) => t.tradeId === target.tradeId), "old id removed");
    assert.ok(trades.some((t) => t.txHash === target.txHash && t.blockNumber === newBlock.number));
  });
});

describe("failed writes", () => {
  it("transient failures are retried within the run", async () => {
    const { ctx, store, logs } = makeContext();
    store.failNext("create", 2);
    const r = await syncOnce(ctx);
    assert.equal(r.tradesCreated, fixture.expected.tradeCount);
    assert.ok(logs.filter((m) => m.startsWith("retry")).length >= 2);
  });

  it("a persistent failure leaves the checkpoint in place; the next run finishes without duplicates", async () => {
    const { ctx, store, stateStore } = makeContext();
    store.failNext("create", 10, 2); // two creates succeed, then every create fails
    await assert.rejects(syncOnce(ctx), /failed after 3 attempts/);
    const saved = (await stateStore.load())!;
    assert.equal(saved.lastProcessedBlock, BigInt(fixture.startBlock) - 1n, "checkpoint not advanced");
    assert.equal(store.writes.filter((w) => w.op === "create").length, 2);

    store.clearFailures(); // healthy again
    const r = await syncOnce(ctx);
    assert.equal(r.mode, "incremental");
    assert.equal(store.live("trade").length, fixture.expected.tradeCount);
    assert.equal(store.live("listing").length, 3);
    assert.equal(listingsOf(store).get(A)!.salesCount, 3n);
  });
});

describe("rebuild", () => {
  it("restores Arkiv from contract events alone and ignores other owners' look-alike entities", async () => {
    const { ctx, store, stateStore } = makeContext();
    await syncOnce(ctx);
    const canonical = JSON.stringify(
      store.live("listing").map((r) => r.values).sort((x, y) => Number((x as ListingValues).publicationId - (y as ListingValues).publicationId)),
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );

    // Damage: one trade deleted, one listing stale, a spoofed listing from another owner, state lost.
    const someTrade = store.live("trade")[0];
    const [tradeKey] = [...store.rows.entries()].find(([, r]) => r === someTrade)!;
    store.rows.delete(tradeKey);
    const [aKey, aRow] = [...store.rows.entries()].find(([, r]) => r.kind === "listing" && (r.values as ListingValues).publicationId.toString() === A)!;
    aRow.values = { ...(aRow.values as ListingValues), title: "stale", contentHash: `0x${"00".repeat(32)}` };
    const spoof = store.injectForeign("listing", { ...(aRow.values as ListingValues), title: "SPOOF" }, "0x000000000000000000000000000000000000dEaD");
    stateStore.text = null;

    const r = await rebuild(ctx);
    assert.equal(r.tradesCreated, 1);
    assert.equal(r.listingsPatched, 1);
    assert.equal(store.live("trade").length, fixture.expected.tradeCount);
    const restored = JSON.stringify(
      store.live("listing").map((x) => x.values).sort((x, y) => Number((x as ListingValues).publicationId - (y as ListingValues).publicationId)),
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    assert.equal(restored, canonical);
    assert.ok(store.rows.has(spoof), "another owner's entity is neither read nor touched");
    assert.ok(store.rows.has(aKey));
  });
});

describe("expiry and renewal", () => {
  it("extends entities close to expiry and leaves rejected listings to expire", async () => {
    const { ctx, store } = makeContext();
    await syncOnce(ctx);
    store.advanceBlocks(BigInt(160 * store.blocksPerDay())); // 20 days left, inside the 30-day window
    const r = await renew(ctx);
    assert.equal(r.extended, 2 + fixture.expected.tradeCount); // A, C and every trade
    assert.equal(r.skippedInactive, 1); // B (rejected)
    for (const row of store.live("trade")) assert.equal(row.expiresAt, store.block + BigInt(180 * store.blocksPerDay()));
  });

  it("recreates entities that already expired (e.g. after an outage)", async () => {
    const { ctx, store } = makeContext();
    await syncOnce(ctx);
    store.advanceBlocks(BigInt(181 * store.blocksPerDay())); // everything expired
    assert.equal(store.rows.size, 0);
    const r = await renew(ctx);
    assert.equal(r.recreated, 2 + fixture.expected.tradeCount);
    assert.equal(store.live("trade").length, fixture.expected.tradeCount);
    assert.deepEqual([...listingsOf(store).keys()].sort(), [A, C].sort());
  });
});

describe("read helpers", () => {
  const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
  const writer = getAddress("0x00000000000000000000000000000000000000aa");

  it("builds listing searches scoped to the writer, with lowercase genre and language and u256 price bounds", () => {
    const q = buildListingQuery(client, {
      writer,
      chainId: 11155111,
      genre: " Fantasy ",
      language: "EN",
      author: writer,
      minPrice: 1n,
      maxPrice: parseEther("0.05"),
      reviewStatus: "published",
    }).toString();
    for (const part of ["fantasy", "en", "price", "$owner", "listingStatus", "metadataStatus", "reviewStatus", "author", "chainId"]) {
      assert.ok(q.includes(part), `query is missing ${part}: ${q}`);
    }
    assert.ok(!q.includes("Fantasy"));
  });

  it("defaults to purchasable, verified listings; 'any' and includeUnverified widen it", () => {
    const names = (f: ReturnType<typeof listingFilters>) => JSON.stringify(f);
    assert.match(names(listingFilters({})), /listed/);
    assert.match(names(listingFilters({})), /verified/);
    assert.doesNotMatch(names(listingFilters({ listingStatus: "any", includeUnverified: true })), /verified|listed/);
  });

  it("builds trade feeds overall and per comic, newest first", () => {
    const all = buildTradeQuery(client, { writer }).toString();
    const one = buildTradeQuery(client, { writer, publicationId: 7n }).toString();
    assert.ok(all.includes("$owner"));
    assert.ok(one.includes("publicationId"));
  });
});

/** Preview ID (bytes32) of a recorded publication, read from its PublicationCreated log. */
function listingsPreview(publicationId: string): Hex {
  const p = emptyProjection();
  const logs = fixture.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
  applyLogs(p, logs.filter((l) => l.topics[0] !== PURCHASED_TOPIC), {
    chainId: fixture.chainId,
    contract: fixture.contract,
    timestamps: new Map(),
  });
  const id = p.listings.get(publicationId)!.arweavePreviewTxId;
  const bytes = Buffer.from(id, "base64url");
  return `0x${bytes.toString("hex")}`;
}
