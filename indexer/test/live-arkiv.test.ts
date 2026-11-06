/**
 * Live checks against the real Arkiv Rabdi testnet. Skipped unless ARKIV_LIVE=1.
 *
 *   npm run indexer:test:live
 *
 * Read checks need no credentials (the public endpoint is rate limited). The write check runs only
 * when ARKIV_PRIVATE_KEY (a funded Rabdi wallet) is set. It writes ONE listing entity built from the
 * recorded local-chain fixture (chainId 31337, so it can never be mistaken for Sepolia data), reads
 * it back, extends it, and prints its key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { arkivPublicClient, createArkivStore } from "../src/arkiv-store.ts";
import { buildListingValues } from "../src/entities.ts";
import { loadPreviewMetadata } from "../src/metadata.ts";
import { applyLogs, emptyProjection } from "../src/projection.ts";
import { recentTrades, searchListings } from "../src/read.ts";
import { FakeFetcher, fixture } from "./support.ts";

const live = process.env.ARKIV_LIVE === "1";
const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";
const privateKey = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

describe("live Arkiv (Rabdi testnet)", { skip: !live && "set ARKIV_LIVE=1" }, () => {
  const client = arkivPublicClient(accessKey);
  const writer = privateKey ? privateKeyToAccount(privateKey).address : ("0x00000000000000000000000000000000000000aa" as const);

  it("is the expected chain", async () => {
    assert.equal(await client.getChainId(), 7794095);
    console.log(`  Arkiv block ${await client.getBlockNumber()}`);
  });

  it("accepts the frontend listing search (all filters) and trade feed queries", async () => {
    const listings = await searchListings(client, {
      writer,
      chainId: fixture.chainId,
      genre: "fantasy",
      language: "en",
      author: writer,
      minPrice: 1n,
      maxPrice: 10n ** 18n,
      reviewStatus: "published",
      limit: 5,
    });
    const trades = await recentTrades(client, { writer, publicationId: 1n, limit: 5 });
    console.log(`  listings: ${listings.listings.length}, trades: ${trades.length} (writer ${writer})`);
    assert.ok(Array.isArray(listings.listings));
    assert.ok(Array.isArray(trades));
  });

  it("writes, reads back and extends one listing entity", { skip: !privateKey && "set ARKIV_PRIVATE_KEY to a funded Rabdi wallet" }, async () => {
    const store = createArkivStore({ accessKey, privateKey: privateKey! });
    const logs = fixture.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
    const timestamps = new Map(Object.entries(fixture.blocks).map(([n, b]) => [BigInt(n), BigInt(b.timestamp)]));
    const p = emptyProjection();
    applyLogs(p, logs, { chainId: fixture.chainId, contract: fixture.contract, timestamps });
    const listing = p.listings.get(fixture.expected.publications.verifiedA)!;
    const metadata = await loadPreviewMetadata(new FakeFetcher(), listing.arweavePreviewTxId, listing.previewManifestHash, {
      now: new Date(),
      retryMs: 1,
      maxAttempts: 1,
    });
    const values = buildListingValues(fixture.chainId, fixture.contract, listing, metadata);

    const existing = await store.findById("listing", values.listingId);
    const written = existing ?? (await store.createListing(values, 1));
    console.log(`  listing entity key: ${written.entityKey} (${existing ? "already existed" : "created"}), expires at Arkiv block ${written.expiresAt}`);

    const found = await store.findById("listing", values.listingId);
    assert.ok(found, "entity readable by listingId");
    assert.equal(found.entityKey, written.entityKey);
    assert.equal(found.contentHash, values.contentHash);

    const page = await searchListings(client, { writer: store.owner, chainId: fixture.chainId, genre: "fantasy" });
    console.log(`  search by genre returned: ${json(page.listings.map((l) => ({ key: l.entityKey, title: l.title, price: l.price })))}`);
    assert.ok(page.listings.some((l) => l.entityKey === written.entityKey));

    const expiresAt = await store.extend(written.entityKey, 2);
    console.log(`  extended to Arkiv block ${expiresAt}`);
    assert.ok(expiresAt >= written.expiresAt);
  });
});
