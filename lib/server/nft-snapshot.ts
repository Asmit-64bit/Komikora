import "server-only";
import { confirmedNFT } from "./nft-chain";
import { nftMetadata } from "./editions";
import { discoverEditions } from "./edition-discovery";
import { ensure } from "@/lib/store";
export async function editionSnapshot(page: number, view: string, wallet?: `0x${string}`, genre?: string, tokenId?: bigint) {
  const cfg = await confirmedNFT(); const base = { address: cfg.address, abi: cfg.abi, blockNumber: cfg.blockNumber };
  const [count, dealCount, offerCount, block, credit] = await Promise.all([
    cfg.client.readContract({ ...base, functionName: "tokenCount" }), cfg.client.readContract({ ...base, functionName: "dealCount" }), cfg.client.readContract({ ...base, functionName: "offerCount" }), cfg.client.getBlock({ blockNumber: cfg.blockNumber }),
    wallet ? cfg.client.readContract({ ...base, functionName: "credits", args: [wallet] }) : BigInt(0),
  ]);
  if (tokenId !== undefined) ensure(tokenId > BigInt(0) && tokenId <= count, "Edition not found.", 404);
  async function token(id: bigint) {
    const [comicId, owner, depositor, sale, auction, ask, minimum] = await Promise.all([
      cfg.client.readContract({ ...base, functionName: "tokenComic", args: [id] }), cfg.client.readContract({ ...base, functionName: "ownerOf", args: [id] }),
      cfg.client.readContract({ ...base, functionName: "depositor", args: [id] }), cfg.client.readContract({ ...base, functionName: "sales", args: [id] }),
      cfg.client.readContract({ ...base, functionName: "auctions", args: [id] }), cfg.client.readContract({ ...base, functionName: "asks", args: [id] }), cfg.client.readContract({ ...base, functionName: "minimumBid", args: [id] }),
    ]);
    const [comic, delisted] = await Promise.all([cfg.client.readContract({ ...base, functionName: "comics", args: [comicId] }), cfg.client.readContract({ ...base, functionName: "delisted", args: [comicId] })]);
    const metadata = await nftMetadata(comic[6], comic[3]).catch(() => ({ title: `Comic #${comicId}`, description: "Metadata temporarily unavailable", genre: "", license: "", cover: undefined, review: undefined, reviewOverride: undefined }));
    return { id: id.toString(), comicId: comicId.toString(), author: comic[0], supply: comic[5], manifestHash: comic[2], metadataHash: comic[3], uri: comic[6], owner, depositor, sale, auction, ask, minimum, delisted, ...metadata };
  }
  const discovery = await discoverEditions(cfg.address, cfg.chainId, page, view, genre);
  const total = discovery ? BigInt(discovery.total) : view === "deals" ? dealCount : view === "offers" ? offerCount : count;
  const ids = tokenId !== undefined ? [tokenId] : discovery?.ids || Array.from({ length: Math.max(0, Math.min(12, Number(total) - page * 12)) }, (_, i) => total - BigInt(page * 12 + i));
  const tokens = view === "deals" || view === "offers" ? [] : await Promise.all(ids.map(token));
  const deals = view === "deals" ? await Promise.all(ids.map(async id => { const d = await cfg.client.readContract({ ...base, functionName: "deals", args: [id] }); return { id: id.toString(), maker: d[0], token: await token(d[1]), value: d[2], end: d[3], active: d[4] }; })) : [];
  const offers = view === "offers" ? await Promise.all(ids.map(async id => { const o = await cfg.client.readContract({ ...base, functionName: "offers", args: [id] }); const d = await cfg.client.readContract({ ...base, functionName: "deals", args: [o[1]] }); return { id: id.toString(), maker: o[0], dealId: o[1].toString(), token: await token(o[2]), topUp: o[3], active: o[4], target: await token(d[1]), dealMaker: d[0], end: d[3], dealActive: d[4] }; })) : [];
  return JSON.parse(JSON.stringify({ tokens, deals, offers, total, credit, timestamp: block.timestamp, block: cfg.blockNumber, confirmations: cfg.confirmations, discovery: discovery ? "arkiv" : "rpc" }, (_, v) => typeof v === "bigint" ? v.toString() : v));
}
