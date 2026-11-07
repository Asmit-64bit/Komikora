import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, parseEther, zeroAddress } from "viem";
import { readingPermitTypes, teamApprovalTypes } from "../../lib/reading-permit.js";
const { viem, networkHelpers: h } = await network.create();
async function fixture() {
  const [author, collaborator, reviewer, treasury, alice, bob, outsider] = await viem.getWalletClients();
  const market = await viem.deployContract("ConsentCraftReading", [reviewer.account.address, treasury.account.address]);
  return { author, collaborator, reviewer, treasury, alice, bob, outsider, market, client: await viem.getPublicClient() };
}
describe("Unanimous publication and fixed-price reading", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await h.loadFixture(fixture); });
  async function submission() {
    const people = [getAddress(f.author.account.address), getAddress(f.collaborator.account.address)]; const allocations = [6000, 4000];
    const domain = { name: "ConsentCraftReading", version: "1", chainId: 31337, verifyingContract: f.market.address };
    const uri = `ar://${"a".repeat(43)}`; const approvalDeadline = BigInt(await h.time.latest()) + 86400n;
    const approval = { key: keccak256(toHex("review-version-one")), contentHash: keccak256(toHex("all-saved-pages-and-credits")), licenseHash: keccak256(toHex("reading license")), contributorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint16[]" }], [people, allocations])), price: parseEther("0.01"), approvalDeadline };
    const permit = { author: people[0], ...approval, manifestHash: keccak256(toHex("encrypted pages")), metadataHash: keccak256(toHex("metadata")), uriHash: keccak256(toHex(uri)), deadline: BigInt(await h.time.latest()) + 600n };
    const approvals = await Promise.all([f.author, f.collaborator].map(w => w.signTypedData({ account: w.account, domain, types: teamApprovalTypes, primaryType: "TeamApproval", message: approval })));
    const signature = await f.reviewer.signTypedData({ account: f.reviewer.account, domain, types: readingPermitTypes, primaryType: "Permit", message: permit });
    return { permit, uri, team: { people, allocations, approvals }, signature, domain, approval };
  }
  async function publish() { const s = await submission(); await f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account }); return s; }
  it("requires every collaborator's signature, including a collaborator with a zero share", async () => {
    const s = await submission();
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, { ...s.team, approvals: [s.team.approvals[0], "0x"] }, s.signature], { account: f.author.account }));
    const allocations = [10000, 0]; const contributorsHash = keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint16[]" }], [s.team.people, allocations]));
    const permit = { ...s.permit, contributorsHash }; const signature = await f.reviewer.signTypedData({ account: f.reviewer.account, domain: s.domain, types: readingPermitTypes, primaryType: "Permit", message: permit });
    const authorApproval = await f.author.signTypedData({ account: f.author.account, domain: s.domain, types: teamApprovalTypes, primaryType: "TeamApproval", message: { ...s.approval, contributorsHash } });
    await assert.rejects(f.market.write.publishComic([permit, s.uri, { ...s.team, allocations, approvals: [authorApproval, "0x"] }, signature], { account: f.author.account }));
    assert.equal(await f.market.read.comicCount(), 0n);
  });
  it("rejects a changed price, pages, license, split, signer or publication caller", async () => {
    const s = await submission();
    for (const change of [{ price: s.permit.price + 1n }, { contentHash: keccak256(toHex("edited page")) }, { licenseHash: keccak256(toHex("new license")) }]) {
      const permit = { ...s.permit, ...change }; const signature = await f.reviewer.signTypedData({ account: f.reviewer.account, domain: s.domain, types: readingPermitTypes, primaryType: "Permit", message: permit });
      await assert.rejects(f.market.write.publishComic([permit, s.uri, s.team, signature], { account: f.author.account }));
    }
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, { ...s.team, allocations: [5000, 5000] }, s.signature], { account: f.author.account }));
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.outsider.account }));
    await f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account });
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account }));
  });
  it("allows approval withdrawal to invalidate even an already issued publication permit", async () => {
    const s = await submission(); await f.market.write.revokeApproval([s.permit.key], { account: f.collaborator.account });
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account }));
    assert.equal(await f.market.read.comicCount(), 0n);
  });
  it("lets multiple independent readers buy the same comic and retain access", async () => {
    const s = await publish();
    assert.equal(await f.market.read.canRead([1n, f.alice.account.address]), false);
    for (const buyer of [f.alice, f.bob]) await f.market.write.buyReading([1n], { account: buyer.account, value: s.permit.price });
    assert.equal(await f.market.read.canRead([1n, f.alice.account.address]), true);
    assert.equal(await f.market.read.canRead([1n, f.bob.account.address]), true);
    assert.equal((await f.market.read.comics([1n]))[9], 2n);
    assert.equal(await f.market.read.canRead([1n, f.collaborator.account.address]), true);
    await assert.rejects(f.market.write.buyReading([1n], { account: f.alice.account, value: s.permit.price }));
    await assert.rejects(f.market.write.buyReading([1n], { account: f.outsider.account, value: s.permit.price - 1n }));
    await assert.rejects(f.market.write.buyReading([1n], { account: f.outsider.account, value: s.permit.price + 1n }));
  });
  it("splits each fixed-price purchase and keeps all credits fully backed", async () => {
    const s = await publish(); await f.market.write.buyReading([1n], { account: f.alice.account, value: s.permit.price });
    const fee = s.permit.price * 250n / 10000n; const net = s.permit.price - fee;
    assert.equal(await f.market.read.credits([f.treasury.account.address]), fee);
    assert.equal(await f.market.read.credits([f.collaborator.account.address]), net * 4000n / 10000n);
    assert.equal(await f.market.read.credits([f.author.account.address]), net - net * 4000n / 10000n);
    assert.equal(await f.market.read.totalCredits(), s.permit.price);
    await f.market.write.withdraw([f.collaborator.account.address], { account: f.collaborator.account });
    assert.equal(await f.market.read.credits([f.collaborator.account.address]), 0n);
    assert.equal(await f.client.getBalance({ address: f.market.address }), await f.market.read.totalCredits());
    await assert.rejects(f.market.write.withdraw([zeroAddress], { account: f.author.account }));
  });
  it("stops new purchases when delisted but preserves existing readers", async () => {
    const s = await publish(); await f.market.write.buyReading([1n], { account: f.alice.account, value: s.permit.price });
    await assert.rejects(f.market.write.setDelisted([1n, true], { account: f.author.account }));
    await f.market.write.setDelisted([1n, true], { account: f.reviewer.account });
    await assert.rejects(f.market.write.buyReading([1n], { account: f.bob.account, value: s.permit.price }));
    assert.equal(await f.market.read.canRead([1n, f.alice.account.address]), true);
    assert.equal(await f.market.read.canRead([0n, f.alice.account.address]), false);
  });
  it("rejects expired approvals and permits from another contract", async () => {
    const s = await submission(); const other = await viem.deployContract("ConsentCraftReading", [f.reviewer.account.address, f.treasury.account.address]);
    await assert.rejects(other.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account }));
    await h.time.increase(86401);
    await assert.rejects(f.market.write.publishComic([s.permit, s.uri, s.team, s.signature], { account: f.author.account }));
  });
});
