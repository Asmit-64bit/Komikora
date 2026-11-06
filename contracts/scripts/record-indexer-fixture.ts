/**
 * Records real ConsentCraftMarket logs for the indexer's tests.
 *
 *   npm run contracts:record-indexer-fixture
 *
 * Runs the real contract on Hardhat's in-process chain through a representative lifecycle,
 * then writes every raw log, every block (number, hash, parent hash, timestamp) and the preview
 * manifests the publications reference to indexer/test/fixtures/market-events.json.
 *
 * All Arweave IDs and manifests here are TEST FIXTURES, not real Arweave data.
 */
import { writeFileSync } from "node:fs";
import { network } from "hardhat";
import { keccak256, parseEther, toBytes, toHex, type Hex } from "viem";

import { bytes32ToArweaveTxId } from "../lib/arweave-tx-id.js";
import { createSamplePublication, deployMarket, sampleCertificate, sampleReport, signCertificate, signReport, Action } from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();
const f = await deployMarket(viem);
const publicClient = f.publicClient;
const buyers = (await viem.getWalletClients()).slice(9, 13);
const now = async () => BigInt(await networkHelpers.time.latest());

/** Canonical preview manifest bytes: fixed key order, no whitespace. */
function manifestBytes(m: { title: string; description: string; language: string; genre: string; previewImages: string[] }) {
  return JSON.stringify({ schema: "consentcraft.preview.v1", ...m });
}
const fixtureId = (label: string) => keccak256(toHex(`INDEXER TEST FIXTURE - not a real Arweave tx - ${label}`));

const manifests: Record<string, string> = {}; // arweave tx id -> base64 of the bytes a gateway would serve

async function publication(label: string, meta: Parameters<typeof manifestBytes>[0], opts: { tamper?: boolean; price?: bigint; deposit?: bigint } = {}) {
  const bytes = manifestBytes(meta);
  const previewId = fixtureId(`${label} preview`);
  const served = opts.tamper ? bytes.replace(meta.title, `${meta.title} (tampered)`) : bytes;
  manifests[bytes32ToArweaveTxId(previewId)] = Buffer.from(served).toString("base64");
  return createSamplePublication(f, await now(), {
    previewManifestHash: keccak256(toBytes(bytes)),
    arweavePreviewTxId: previewId,
    arweaveBundleTxId: fixtureId(`${label} bundle`),
    price: opts.price ?? parseEther("0.01"),
    deposit: opts.deposit ?? parseEther("0.05"),
  });
}

async function report(id: bigint, quote: Awaited<ReturnType<typeof publication>>["quote"], flagged: boolean) {
  const r = sampleReport(id, quote, { flagged });
  await f.market.write.submitReviewReport([id, r, await signReport(f.reporter, f.chainId, f.market.address, r)]);
}

async function buy(id: bigint, buyer: (typeof buyers)[number]) {
  const p = await f.market.read.getPublication([id]);
  const cert = sampleCertificate(buyer.account.address, await now(), { action: Action.Purchase });
  await f.market.write.purchase(
    [id, keccak256(toHex(`fixture request ${id} ${buyer.account.address}`)), cert, await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert)],
    { account: buyer.account, value: p.price },
  );
}

const startBlock = await publicClient.getBlockNumber();

// 1. Verified manifest, approved, published, three sales (R reaches S = 0.03 on the third).
const a = await publication("comic A", {
  title: "Moonlit Couriers",
  description: "Two couriers race a storm across a floating city.",
  language: "en",
  genre: "Fantasy",
  previewImages: [`ar://${bytes32ToArweaveTxId(fixtureId("comic A page 1"))}`],
}, { deposit: parseEther("0.03") });
await report(a.id, a.quote, false);
await f.market.write.publish([a.id], { account: f.author.account });
for (const b of buyers.slice(0, 3)) await buy(a.id, b);

// 2. Manifest served with different bytes than the signed hash (hash mismatch); flagged, then finalized.
const b = await publication("comic B", {
  title: "Paper Lanterns",
  description: "A quiet story about a night market.",
  language: "ja",
  genre: "Slice of Life",
  previewImages: [`ar://${bytes32ToArweaveTxId(fixtureId("comic B page 1"))}`],
}, { tamper: true });
await report(b.id, b.quote, true);
await networkHelpers.time.increase(Number(72n * 3600n));
await f.market.write.finalizeRejection([b.id]);

// 3. Verified manifest, published, one sale, then refunded and delisted after the refund delay.
const c = await publication("comic C", {
  title: "Iron Orchard",
  description: "Robots learn to grow apples after the collapse.",
  language: "en",
  genre: "Science Fiction",
  previewImages: [],
}, { price: parseEther("0.002") });
await report(c.id, c.quote, false);
await f.market.write.publish([c.id], { account: f.author.account });
await buy(c.id, buyers[3]);
await networkHelpers.time.increase(Number(30n * 24n * 3600n));
await f.market.write.refundAndDelist([c.id, 0n], { account: f.author.account });

const endBlock = await publicClient.getBlockNumber();
const logs = await publicClient.getLogs({ address: f.market.address, fromBlock: startBlock, toBlock: endBlock });
const blocks: Record<string, { hash: Hex; parentHash: Hex; timestamp: string }> = {};
for (let n = startBlock; n <= endBlock; n++) {
  const blk = await publicClient.getBlock({ blockNumber: n });
  blocks[n.toString()] = { hash: blk.hash, parentHash: blk.parentHash, timestamp: blk.timestamp.toString() };
}

const fixture = {
  note: "Recorded from the real contract on Hardhat's in-process chain by contracts/scripts/record-indexer-fixture.ts. Arweave IDs and manifests are TEST FIXTURES.",
  chainId: f.chainId,
  contract: f.market.address,
  startBlock: startBlock.toString(),
  endBlock: endBlock.toString(),
  blocks,
  logs: logs.map((l) => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber.toString(),
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    transactionIndex: l.transactionIndex,
    logIndex: l.logIndex,
  })),
  manifests,
  expected: {
    publications: { verifiedA: a.id.toString(), mismatchB: b.id.toString(), delistedC: c.id.toString() },
    tradeCount: 4,
  },
};
writeFileSync("../indexer/test/fixtures/market-events.json", `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Recorded ${logs.length} logs over blocks ${startBlock}-${endBlock} to indexer/test/fixtures/market-events.json`);
