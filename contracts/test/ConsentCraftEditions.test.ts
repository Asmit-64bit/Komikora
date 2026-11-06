import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, parseEther, zeroAddress, zeroHash, type Hex } from "viem";
import { editionPermitTypes } from "../../lib/edition-permit.js";
const { viem, networkHelpers: h } = await network.create();
async function fixture() {
  const [author, reviewer, treasury, alice, bob, carol] = await viem.getWalletClients();
  const nft = await viem.deployContract("ConsentCraftEditions", [reviewer.account.address, treasury.account.address]);
  return { nft, author, reviewer, treasury, alice, bob, carol, client: await viem.getPublicClient() };
}
describe("NFT editions, sales and transferable reading", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await h.loadFixture(fixture); });
  async function permit(supply = 4, signer = f.reviewer, auctionHash: Hex = zeroHash) {
    const uri = "ar://" + "a".repeat(43);
    const p = { author: f.author.account.address, key: keccak256(toHex("comic")), manifestHash: keccak256(toHex("encrypted-pages")), metadataHash: keccak256(toHex("public-metadata")), uriHash: keccak256(toHex(uri)), licenseHash: keccak256(toHex("reading license")), auctionHash, supply, deadline: BigInt(await h.time.latest()) + 10000n };
    const signature = await signer.signTypedData({ account: signer.account, domain: { name: "ConsentCraftEditions", version: "1", chainId: 31337, verifyingContract: f.nft.address }, types: editionPermitTypes, primaryType: "Permit", message: p });
    return { p, signature, uri };
  }
  async function mint() { const { p, signature, uri } = await permit(); await f.nft.write.createComic([p, uri, signature], { account: f.author.account }); }
  async function sold(token = 1n, price = parseEther("1"), buyer = f.alice) {
    await f.nft.write.openAuction([token, price, 3600n], { account: f.author.account });
    await f.nft.write.bid([token], { account: buyer.account, value: price });
    await h.time.increase(3601); await f.nft.write.settleAuction([token]);
  }
  it("exports the real ABI, supports NFT and royalty standards, stays deployable", async () => {
    const a = JSON.parse(readFileSync("artifacts/contracts/ConsentCraftEditions.sol/ConsentCraftEditions.json", "utf8"));
    assert.deepEqual(a.abi, JSON.parse(readFileSync("abi/ConsentCraftEditions.json", "utf8")));
    assert.ok((a.deployedBytecode.length - 2) / 2 < 24576);
    assert.equal(await f.nft.read.supportsInterface(["0x80ac58cd"]), true);
    assert.equal(await f.nft.read.supportsInterface(["0x2a55205a"]), true);
  });
  it("binds author, supply, metadata URI and content to a single use reviewer permit", async () => {
    const { p, uri, signature } = await permit();
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri, signature], { account: f.alice.account }), f.nft, "Unauthorized");
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([{ ...p, supply: 3 }, uri, signature], { account: f.author.account }), f.nft, "Unauthorized");
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri + "b", signature], { account: f.author.account }), f.nft, "Invalid");
    await f.nft.write.createComic([p, uri, signature], { account: f.author.account });
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri, signature], { account: f.author.account }), f.nft, "Invalid");
    assert.equal(await f.nft.read.tokenCount(), 4n); assert.equal(await f.nft.read.tokenURI([1n]), uri);
  });
  it("rejects expired, oversized and unapproved submissions", async () => {
    for (const n of [0, 26]) { const { p, uri, signature } = await permit(n); await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri, signature], { account: f.author.account }), f.nft, "Invalid"); }
    const { p, uri, signature } = await permit(2, f.alice);
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri, signature], { account: f.author.account }), f.nft, "Unauthorized");
    await h.time.increase(10001);
    await viem.assertions.revertWithCustomError(f.nft.write.createComic([p, uri, signature], { account: f.author.account }), f.nft, "Invalid");
  });
  it("enforces reserves and outbid refunds without pushing funds to bidders", async () => {
    await mint(); await f.nft.write.openAuction([1n, 100n, 3600n], { account: f.author.account });
    await viem.assertions.revertWithCustomError(f.nft.write.bid([1n], { account: f.alice.account, value: 99n }), f.nft, "TooLow");
    await f.nft.write.bid([1n], { account: f.alice.account, value: 100n });
    assert.equal(await f.nft.read.minimumBid([1n]), 105n);
    await f.nft.write.bid([1n], { account: f.bob.account, value: 105n });
    assert.equal(await f.nft.read.credits([f.alice.account.address]), 100n);
    assert.equal(await f.nft.read.lockedEth(), 105n);
    await viem.assertions.revertWithCustomError(f.nft.write.cancelAuction([1n], { account: f.author.account }), f.nft, "Unavailable");
    await viem.assertions.revertWithCustomError(f.nft.write.settleAuction([1n]), f.nft, "Unavailable");
  });
  it("extends late bidding within a hard cap, then settles primary fees and reading access", async () => {
    await mint(); await f.nft.write.openAuction([1n, 10000n, 3600n], { account: f.author.account });
    const a = await f.nft.read.auctions([1n]); await h.time.increaseTo(a[4] - 10n);
    await f.nft.write.bid([1n], { account: f.alice.account, value: 10000n });
    const b = await f.nft.read.auctions([1n]); assert.ok(b[4] > a[4] && b[4] <= b[5]);
    await h.time.increaseTo(b[4]); await f.nft.write.settleAuction([1n]);
    assert.equal(await f.nft.read.ownerOf([1n]), getAddress(f.alice.account.address));
    assert.equal(await f.nft.read.canRead([1n, f.alice.account.address]), true);
    assert.equal(await f.nft.read.canRead([1n, f.author.account.address]), false);
    assert.equal(await f.nft.read.credits([f.author.account.address]), 9750n);
    assert.equal(await f.nft.read.credits([f.treasury.account.address]), 250n);
    assert.equal((await f.nft.read.sales([1n]))[0], 10000n);
    await viem.assertions.revertWithCustomError(f.nft.write.settleAuction([1n]), f.nft, "Unavailable");
  });
  it("releases unsold and cancelled editions without assigning a sale price", async () => {
    await mint(); await f.nft.write.openAuction([1n, 100n, 3600n], { account: f.author.account }); await f.nft.write.cancelAuction([1n], { account: f.author.account });
    await f.nft.write.openAuction([1n, 200n, 3600n], { account: f.author.account }); await h.time.increase(3601); await f.nft.write.settleAuction([1n]);
    assert.equal(await f.nft.read.ownerOf([1n]), getAddress(f.author.account.address)); assert.equal((await f.nft.read.sales([1n]))[0], 0n);
    assert.equal(await f.nft.read.canRead([1n, f.author.account.address]), false);
    await viem.assertions.revertWithCustomError(f.nft.write.transferFrom([f.author.account.address, f.bob.account.address, 1n], { account: f.author.account }), f.nft, "Invalid");
  });
  it("revokes the old owner's access on external transfer, and invalidates stale asks", async () => {
    await mint(); await sold();
    await sold(2n, 10000n, f.carol);
    await f.nft.write.setAsk([1n, parseEther("2"), 3600n], { account: f.alice.account });
    await f.nft.write.transferFrom([f.alice.account.address, f.bob.account.address, 1n], { account: f.alice.account });
    assert.equal(await f.nft.read.canRead([1n, f.alice.account.address]), false); assert.equal(await f.nft.read.canRead([1n, f.bob.account.address]), true);
    assert.equal((await f.nft.read.sales([1n]))[1], parseEther("1"));
    await viem.assertions.revertWithCustomError(f.nft.write.buy([1n, parseEther("2")], { account: f.carol.account, value: parseEther("2") }), f.nft, "Unavailable");
    await f.nft.write.transferFrom([f.bob.account.address, f.alice.account.address, 1n], { account: f.bob.account });
    assert.equal((await f.nft.read.asks([1n]))[1], 0n);
  });
  it("records secondary sales while preserving first and auction prices and distributing royalties", async () => {
    await mint(); await sold(1n, 10000n);
    await sold(2n, 10000n, f.bob);
    await f.nft.write.setAsk([1n, 20000n, 3600n], { account: f.alice.account });
    await viem.assertions.revertWithCustomError(f.nft.write.buy([1n, 19999n], { account: f.bob.account, value: 20000n }), f.nft, "WrongValue");
    await f.nft.write.buy([1n, 20000n], { account: f.bob.account, value: 20000n });
    const s = await f.nft.read.sales([1n]); assert.equal(s[0], 10000n); assert.equal(s[1], 20000n); assert.equal(s[2], 10000n);
    assert.equal(await f.nft.read.credits([f.alice.account.address]), 18500n); assert.equal(await f.nft.read.credits([f.author.account.address]), 20500n);
    assert.equal(await f.nft.read.canRead([1n, f.alice.account.address]), false);
  });
  it("supports equal-value swaps and exact ETH top-ups without inventing a sale price", async () => {
    await mint(); await sold(1n, 200n); await sold(2n, 100n, f.bob); await sold(3n, 200n, f.carol);
    await f.nft.write.openDeal([1n, 3600n], { account: f.alice.account });
    assert.equal(await f.nft.read.canRead([1n, f.alice.account.address]), true);
    await viem.assertions.revertWithCustomError(f.nft.write.offer([1n, 2n], { account: f.bob.account, value: 99n }), f.nft, "WrongValue");
    await f.nft.write.offer([1n, 2n], { account: f.bob.account, value: 100n });
    await f.nft.write.offer([1n, 3n], { account: f.carol.account, value: 0n });
    await viem.assertions.revertWithCustomError(f.nft.write.accept([1n], { account: f.bob.account }), f.nft, "Unauthorized");
    await f.nft.write.accept([1n], { account: f.alice.account });
    assert.equal(await f.nft.read.ownerOf([1n]), getAddress(f.bob.account.address)); assert.equal(await f.nft.read.ownerOf([2n]), getAddress(f.alice.account.address));
    assert.equal((await f.nft.read.sales([1n]))[1], 200n); assert.equal(await f.nft.read.credits([f.alice.account.address]), 100n);
    await f.nft.write.closeOffer([2n], { account: f.alice.account }); assert.equal(await f.nft.read.ownerOf([3n]), getAddress(f.carol.account.address));
  });
  it("allows expired deals and offers to be reclaimed, covers every ETH liability", async () => {
    await mint(); await sold(1n, 200n); await sold(2n, 100n, f.bob);
    await f.nft.write.openDeal([1n, 3600n], { account: f.alice.account }); await f.nft.write.offer([1n, 2n], { account: f.bob.account, value: 100n });
    await h.time.increase(3601); await f.nft.write.closeDeal([1n]); await f.nft.write.closeOffer([1n]);
    assert.equal(await f.nft.read.lockedEth(), 0n); assert.equal(await f.nft.read.credits([f.bob.account.address]), 100n);
    const balance = await f.client.getBalance({ address: f.nft.address }); assert.equal(balance, await f.nft.read.totalCredits());
    await f.nft.write.withdraw([f.bob.account.address], { account: f.bob.account }); assert.equal(await f.nft.read.credits([f.bob.account.address]), 0n);
  });
  it("delists new sales without revoking owners and prevents unauthorized or accidental deposits", async () => {
    await mint(); await sold();
    await viem.assertions.revertWithCustomError(f.nft.write.setDelisted([1n, true], { account: f.bob.account }), f.nft, "Unauthorized");
    await f.nft.write.setDelisted([1n, true], { account: f.reviewer.account });
    assert.equal(await f.nft.read.canRead([1n, f.alice.account.address]), true);
    await viem.assertions.revertWithCustomError(f.nft.write.openAuction([1n, 1n, 3600n], { account: f.alice.account }), f.nft, "Invalid");
    await viem.assertions.revertWithCustomError(f.nft.write.transferFrom([f.alice.account.address, f.nft.address, 1n], { account: f.alice.account }), f.nft, "Invalid");
    await viem.assertions.revertWithCustomError(f.nft.write.withdraw([zeroAddress], { account: f.author.account }), f.nft, "Invalid");
  });
  it("locks Trade for empty wallets and unsold creator inventory, and unlocks after a first sale", async () => {
    await mint(); assert.equal(await f.nft.read.canTrade([f.author.account.address]), false);
    assert.equal(await f.nft.read.canTrade([f.alice.account.address]), false);
    await sold(); assert.equal(await f.nft.read.qualifyingBalance([f.alice.account.address]), 1n);
    assert.equal(await f.nft.read.canTrade([f.alice.account.address]), true);
    await f.nft.write.transferFrom([f.alice.account.address, f.bob.account.address, 1n], { account: f.alice.account });
    assert.equal(await f.nft.read.canTrade([f.alice.account.address]), false);
    assert.equal(await f.nft.read.canTrade([f.bob.account.address]), true);
  });
  it("requires an existing collected comic to buy or bid on secondary sales", async () => {
    await mint(); await sold(1n, 100n);
    await f.nft.write.setAsk([1n, 200n, 3600n], { account: f.alice.account });
    await viem.assertions.revertWithCustomError(f.nft.write.buy([1n, 200n], { account: f.bob.account, value: 200n }), f.nft, "TradeLocked");
    await f.nft.write.openAuction([1n, 200n, 3600n], { account: f.alice.account });
    await viem.assertions.revertWithCustomError(f.nft.write.bid([1n], { account: f.bob.account, value: 200n }), f.nft, "TradeLocked");
    // A newcomer may still bid on a first sale in Marketplace.
    await f.nft.write.openAuction([2n, 100n, 3600n], { account: f.author.account });
    await f.nft.write.bid([2n], { account: f.bob.account, value: 100n });
    await h.time.increase(3601); await f.nft.write.settleAuction([2n]);
    assert.equal(await f.nft.read.canTrade([f.bob.account.address]), true);
  });
  it("enforces the first-auction terms bound into a publication approval", async () => {
    const auctionHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [100n, 3600n]));
    const { p, uri, signature } = await permit(1, f.reviewer, auctionHash);
    await f.nft.write.createComic([p, uri, signature], { account: f.author.account });
    await viem.assertions.revertWithCustomError(f.nft.write.openAuction([1n, 101n, 3600n], { account: f.author.account }), f.nft, "Invalid");
    await viem.assertions.revertWithCustomError(f.nft.write.openAuction([1n, 100n, 7200n], { account: f.author.account }), f.nft, "Invalid");
    await f.nft.write.openAuction([1n, 100n, 3600n], { account: f.author.account });
  });
  it("keeps Trade unlocked while the last comic is escrowed and permits exits after relocking", async () => {
    await mint(); await sold(1n, 100n);
    await f.nft.write.openDeal([1n, 3600n], { account: f.alice.account });
    assert.equal(await f.nft.read.qualifyingBalance([f.alice.account.address]), 1n);
    await f.nft.write.closeDeal([1n], { account: f.alice.account });
    assert.equal(await f.nft.read.qualifyingBalance([f.alice.account.address]), 1n);
    await f.nft.write.openAuction([1n, 200n, 3600n], { account: f.alice.account });
    assert.equal(await f.nft.read.canTrade([f.alice.account.address]), true);
    await f.nft.write.cancelAuction([1n], { account: f.alice.account });
    await f.nft.write.setAsk([1n, 200n, 3600n], { account: f.alice.account });
    await sold(2n, 100n, f.bob);
    await f.nft.write.setAsk([1n, 200n, 3600n], { account: f.alice.account });
    await f.nft.write.buy([1n, 200n], { account: f.bob.account, value: 200n });
    assert.equal(await f.nft.read.canTrade([f.alice.account.address]), false);
    await f.nft.write.withdraw([f.alice.account.address], { account: f.alice.account });
    assert.equal(await f.nft.read.credits([f.alice.account.address]), 0n);
  });
});
