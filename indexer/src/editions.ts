// Independent NFT index. Backfills confirmed events in bounded RPC ranges. Each run
// rebuilds deterministically, reconciles removed/reorged records and renews expiry.
import { createPublicClient as chainClient, getAddress, http, isAddress, keccak256, parseEventLogs, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq, gt, asc } from "@arkiv-network/sdk/query";
import { addr, key, str, u64 } from "@arkiv-network/sdk/schema";
import { EditionIndex } from "./edition-schema.ts";
import { editionsAbi } from "../../contracts/abi/ConsentCraftEditions.ts";
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
const raw = process.env.NEXT_PUBLIC_EDITIONS_ADDRESS || process.env.INDEXER_EDITIONS_ADDRESS;
const rpc = process.env.INDEXER_SOURCE_RPC_URL || process.env.CHAIN_RPC_URL;
if (!raw || !isAddress(raw) || !rpc) throw new Error("Set INDEXER_EDITIONS_ADDRESS and INDEXER_SOURCE_RPC_URL.");
const address = getAddress(raw); const source = chainClient({ transport: http(rpc) });
const chainId = await source.getChainId(); const start = BigInt(process.env.EDITIONS_START_BLOCK || "0");
const confirmations = BigInt(process.env.INDEXER_CONFIRMATIONS || (chainId === 31337 ? "0" : "2"));
const dry = process.argv.includes("--dry-run");
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY || "" });
const reader = createPublicClient({ chain, transport: http() });
const pk = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
if (!dry && !pk) throw new Error("Set a funded ARKIV_PRIVATE_KEY, or pass --dry-run.");
const account = pk ? privateKeyToAccount(pk) : undefined;
const writer = account ? createWalletClient({ chain, transport: http(), account }) : undefined;
async function sync() {
  const head = await source.getBlockNumber({ cacheTime: 0 }); const blockNumber = head > confirmations ? head - confirmations : 0n;
  const base = { address, abi: editionsAbi, blockNumber };
  const records = new Map<Hex, { kind: string; token: bigint; phase: string; creator: `0x${string}`; title: string; genre: string; payload: string }>();
  const idFor = (id: string) => keccak256(toHex(`${chainId}:${address.toLowerCase()}:${id}`));
  const metadata = new Map<bigint, { title: string; genre: string }>();
  const count = await source.readContract({ ...base, functionName: "tokenCount" });
  for (let token = 1n; token <= count; token++) {
    const comicId = await source.readContract({ ...base, functionName: "tokenComic", args: [token] });
    const comic = await source.readContract({ ...base, functionName: "comics", args: [comicId] });
    let meta = metadata.get(comicId);
    if (!meta) {
      meta = { title: `Comic #${comicId}`, genre: "" };
      if (/^ar:\/\/[\w-]{43}$/.test(comic[6])) try {
        const res = await fetch(`${process.env.ARWEAVE_GATEWAY || "https://arweave.net"}/raw/${comic[6].slice(5)}`, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error("metadata unavailable"); const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 1000000 || keccak256(bytes) !== comic[3]) throw new Error("metadata hash mismatch");
        const m = JSON.parse(new TextDecoder().decode(bytes)); meta = { title: String(m.name).slice(0, 100), genre: String(m.genre || "").slice(0, 60) };
      } catch { /* Keep an explicitly unnamed record and retry next sync. */ }
      metadata.set(comicId, meta);
    }
    const [owner, depositor, sale, auction, ask, delisted] = await Promise.all([
      source.readContract({ ...base, functionName: "ownerOf", args: [token] }), source.readContract({ ...base, functionName: "depositor", args: [token] }),
      source.readContract({ ...base, functionName: "sales", args: [token] }), source.readContract({ ...base, functionName: "auctions", args: [token] }), source.readContract({ ...base, functionName: "asks", args: [token] }), source.readContract({ ...base, functionName: "delisted", args: [comicId] }),
    ]);
    records.set(idFor(`token:${token}`), { kind: "token", token, phase: sale[0] === 0n ? "primary" : "secondary", creator: comic[0], ...meta,
      payload: json({ comicId, token, owner, depositor, supply: comic[5], metadataUri: comic[6], metadataHash: comic[3], manifestHash: comic[2], firstSale: { price: sale[0], at: sale[3] }, latestSale: { price: sale[1], at: sale[4] }, lastAuctionPrice: sale[2], currency: "ETH", auction, ask, delisted, confirmedBlock: blockNumber }) });
  }
  for (let fromBlock = start; fromBlock <= blockNumber; fromBlock += 2000n) {
    const logs = await source.getLogs({ address, fromBlock, toBlock: fromBlock + 1999n > blockNumber ? blockNumber : fromBlock + 1999n });
    const decoded = parseEventLogs({ abi: editionsAbi, logs, strict: true });
    for (const log of decoded) {
      // Immutable public history: includes auctions, bids, sales, asks, swaps and transfers.
      const args = log.args as Record<string, unknown>; const token = BigInt(String(args.tokenId || "0"));
      records.set(idFor(`event:${log.transactionHash}:${log.logIndex}`), { kind: "event", token, phase: log.eventName, creator: address, title: "", genre: "", payload: json({ event: log.eventName, args, tx: log.transactionHash, logIndex: log.logIndex, block: log.blockNumber }) });
    }
  }
  if (dry) { console.log(json({ chainId, contract: address, blockNumber, records: [...records.values()] })); return; }
  const existing = new Map<Hex, { entity: Hex; hash: Hex; expires: bigint }>(); let after: Hex | undefined;
  for (;;) {
    const conditions = [eq("chainId", u64(chainId)), eq("contract", addr(address)), ...(after ? [gt("$key", key(after))] : [])];
    const page = await reader.select({ $key: true, $expiresAt: true, recordId: true, contentHash: true }).from(EditionIndex).where(and(...conditions)).ownedBy(account!.address).orderBy(asc("$key")).limit(100).fetch();
    for (const r of page.entities) existing.set(r.recordId.value, { entity: r.$key, hash: r.contentHash.value, expires: r.$expiresAt });
    if (page.entities.length < 100) break; after = page.entities.at(-1)!.$key;
  }
  const arkivHead = await reader.getBlockNumber();
  for (const [id, record] of records) {
    const hash = keccak256(toHex(json(record))); const prev = existing.get(id);
    const values = { recordId: key(id), chainId: u64(chainId), contract: addr(address), kind: str(record.kind), tokenId: u64(record.token), phase: str(record.phase), creator: addr(record.creator), title: str(record.title), genre: str(record.genre), payload: str(record.payload), contentHash: key(hash), sourceBlock: u64(blockNumber) };
    if (!prev) await writer!.createEntity(EditionIndex, values, { expiration: ExpirationTime.fromDays(180) });
    else {
      if (prev.hash !== hash) await writer!.patchEntity(EditionIndex, prev.entity, { set: values });
      if (prev.expires < arkivHead + 30n * 43200n) await writer!.extendEntity({ entityKey: prev.entity, expiration: ExpirationTime.fromDays(180) });
    }
    existing.delete(id);
  }
  for (const stale of existing.values()) await writer!.deleteEntity({ entityKey: stale.entity });
  console.log(json({ indexed: records.size, chainId, blockNumber, removed: existing.size }));
}
do {
  try { await sync(); }
  catch (error) { if (!process.argv.includes("--watch")) throw error; console.error("NFT index sync failed. Retrying full reconciliation in 30 seconds."); }
  if (!process.argv.includes("--watch")) break;
  await new Promise(r => setTimeout(r, 30000));
} while (true);
