import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, zeroAddress } from "viem";
import { readingPermitTypes, teamApprovalTypes } from "../../lib/reading-permit.js";
const { viem, networkHelpers: h } = await network.create();
const DAY = 86400;
async function fixture() {
  const [author, collaborator, reviewer, treasury, reader, heirA, heirB, guardian, outsider] = await viem.getWalletClients();
  const market = await viem.deployContract("ConsentCraftReadingHeirloom", [reviewer.account.address, treasury.account.address]);
  const people = [getAddress(author.account.address), getAddress(collaborator.account.address)]; const allocations = [6000, 4000];
  const domain = { name: "ConsentCraftReading", version: "1", chainId: 31337, verifyingContract: market.address };
  const uri = `ar://${"a".repeat(43)}`;
  const approval = { key: keccak256(toHex("comic")), contentHash: keccak256(toHex("content")), licenseHash: keccak256(toHex("license")), contributorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint16[]" }], [people, allocations])), price: 10000n, approvalDeadline: BigInt(await h.time.latest()) + 86400n };
  const permit = { author: people[0], ...approval, manifestHash: keccak256(toHex("pages")), metadataHash: keccak256(toHex("metadata")), uriHash: keccak256(toHex(uri)), deadline: BigInt(await h.time.latest()) + 600n };
  const approvals = await Promise.all([author, collaborator].map(w => w.signTypedData({ account: w.account, domain, types: teamApprovalTypes, primaryType: "TeamApproval", message: approval })));
  const signature = await reviewer.signTypedData({ account: reviewer.account, domain, types: readingPermitTypes, primaryType: "Permit", message: permit });
  await market.write.publishComic([permit, uri, { people, allocations, approvals }, signature], { account: author.account });
  return { market, author, collaborator, reviewer, treasury, reader, heirA, heirB, guardian, outsider, client: await viem.getPublicClient() };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function configure(f: F, wallet = f.reader, shares = [6000, 4000]) {
  await f.market.write.configureInheritance([[f.heirA.account.address, f.heirB.account.address], shares, f.guardian.account.address, BigInt(30 * DAY), BigInt(7 * DAY)], { account: wallet.account });
}
async function activate(f: F, wallet = f.reader) {
  const plan = await f.market.read.inheritancePlans([wallet.account.address]);
  await h.time.increaseTo(Number(plan[0]) + 30 * DAY);
  await f.market.write.startInheritanceClaim([wallet.account.address], { account: f.heirA.account });
  const opened = await f.market.read.inheritancePlans([wallet.account.address]);
  await h.time.increaseTo(Number(opened[3]) + 7 * DAY);
  await f.market.write.finalizeInheritance([wallet.account.address], { account: f.heirA.account });
}
describe("Heirloom reading inheritance", () => {
  it("validates opt-in plans and replaces old heirs only before finalization", async () => {
    const f = await h.loadFixture(fixture);
    for (const [heirs, shares, timeout, window] of [
      [[zeroAddress], [10000], 30 * DAY, 7 * DAY], [[f.reader.account.address], [10000], 30 * DAY, 7 * DAY],
      [[f.heirA.account.address, f.heirA.account.address], [5000, 5000], 30 * DAY, 7 * DAY],
      [[f.heirA.account.address], [9000], 30 * DAY, 7 * DAY], [[f.heirA.account.address], [10000], DAY, 7 * DAY],
      [[f.heirA.account.address], [10000], 30 * DAY, DAY],
    ] as const) await assert.rejects(f.market.write.configureInheritance([heirs, shares, f.guardian.account.address, BigInt(timeout), BigInt(window)], { account: f.reader.account }));
    await configure(f); const [heirs, allocations] = await f.market.read.getHeirs([f.reader.account.address]);
    assert.deepEqual(allocations, [6000, 4000]); assert.equal(heirs.length, 2);
    await f.market.write.configureInheritance([[f.outsider.account.address], [10000], zeroAddress, BigInt(30 * DAY), BigInt(7 * DAY)], { account: f.reader.account });
    assert.equal(await f.market.read.heirBps([f.reader.account.address, f.heirA.account.address]), 0);
    await f.market.write.disableInheritance({ account: f.reader.account });
    assert.equal((await f.market.read.inheritancePlans([f.reader.account.address]))[6], false);
  });
  it("enforces both timers, authorization, and owner check-in cancellation", async () => {
    const f = await h.loadFixture(fixture); await configure(f);
    await assert.rejects(f.market.write.startInheritanceClaim([f.reader.account.address], { account: f.heirA.account }), /InheritanceNotReady/);
    await h.time.increase(30 * DAY);
    await assert.rejects(f.market.write.startInheritanceClaim([f.reader.account.address], { account: f.outsider.account }), /InheritanceUnauthorized/);
    await f.market.write.startInheritanceClaim([f.reader.account.address], { account: f.heirA.account });
    await assert.rejects(f.market.write.finalizeInheritance([f.reader.account.address], { account: f.heirA.account }), /InheritanceNotReady/);
    await viem.assertions.emit(f.market.write.checkIn({ account: f.reader.account }), f.market, "InheritanceClaimCancelled");
    assert.equal((await f.market.read.inheritancePlans([f.reader.account.address]))[3], 0n);
  });
  it("resets activity on marketplace purchases and limits guardian vetoes", async () => {
    const f = await h.loadFixture(fixture); await configure(f);
    await h.time.increase(30 * DAY); await f.market.write.startInheritanceClaim([f.reader.account.address], { account: f.heirA.account });
    await f.market.write.buyReading([1n], { account: f.reader.account, value: 10000n });
    assert.equal((await f.market.read.inheritancePlans([f.reader.account.address]))[3], 0n);
    for (let i = 0; i < 2; i++) { await h.time.increase(30 * DAY); await f.market.write.startInheritanceClaim([f.reader.account.address], { account: f.heirA.account }); await f.market.write.vetoInheritanceClaim([f.reader.account.address], { account: f.guardian.account }); }
    await assert.rejects(f.market.write.vetoInheritanceClaim([f.reader.account.address], { account: f.guardian.account }), /InheritanceUnauthorized/);
    assert.equal(await f.market.read.credits([f.guardian.account.address]), 0n);
  });
  it("lets heirs claim purchased access after finalization without changing authorship", async () => {
    const f = await h.loadFixture(fixture); await f.market.write.buyReading([1n], { account: f.reader.account, value: 10000n }); await configure(f);
    await assert.rejects(f.market.write.inheritReading([f.reader.account.address, [1n]], { account: f.heirA.account }));
    await activate(f);
    assert.equal(await f.market.read.canRead([1n, f.reader.account.address]), false);
    for (const heir of [f.heirA, f.heirB]) { await viem.assertions.emit(f.market.write.inheritReading([f.reader.account.address, [1n]], { account: heir.account }), f.market, "ReadingInherited"); assert.equal(await f.market.read.canRead([1n, heir.account.address]), true); }
    await assert.rejects(f.market.write.inheritReading([f.reader.account.address, [1n]], { account: f.heirA.account }));
    await assert.rejects(f.market.write.inheritReading([f.reader.account.address, [99n]], { account: f.heirB.account }));
    await assert.rejects(f.market.write.checkIn({ account: f.reader.account }), /InheritanceFinalized/);
    assert.equal((await f.market.read.comics([1n]))[0], getAddress(f.author.account.address));
    assert.deepEqual((await f.market.read.getContributors([1n]))[1], [6000, 4000]);
  });
  it("splits unwithdrawn and future creator proceeds cumulatively and preserves backing", async () => {
    const f = await h.loadFixture(fixture); await f.market.write.buyReading([1n], { account: f.reader.account, value: 10000n });
    await f.market.write.withdraw([f.author.account.address], { account: f.author.account });
    await f.market.write.buyReading([1n], { account: f.outsider.account, value: 10000n });
    const inherited = await f.market.read.credits([f.author.account.address]);
    await configure(f, f.author); await activate(f, f.author);
    assert.equal(await f.market.read.claimableInheritedProceeds([f.author.account.address, f.heirA.account.address]), inherited * 6000n / 10000n);
    await assert.rejects(f.market.write.withdraw([f.author.account.address], { account: f.author.account }), /InheritanceFinalized/);
    for (const heir of [f.heirA, f.heirB]) await f.market.write.withdrawInheritedProceeds([f.author.account.address, heir.account.address], { account: heir.account });
    await assert.rejects(f.market.write.withdrawInheritedProceeds([f.author.account.address, f.heirA.account.address], { account: f.heirA.account }));
    await f.market.write.buyReading([1n], { account: f.guardian.account, value: 10000n });
    for (const heir of [f.heirA, f.heirB]) assert.ok(await f.market.read.claimableInheritedProceeds([f.author.account.address, heir.account.address]) > 0n);
    await f.market.write.inheritReading([f.author.account.address, [1n]], { account: f.heirA.account });
    assert.equal(await f.market.read.canRead([1n, f.heirA.account.address]), true);
    assert.equal(await f.market.read.isContributor([1n, f.heirA.account.address]), false);
    assert.equal(await f.client.getBalance({ address: f.market.address }), await f.market.read.totalCredits());
  });
  it("a failed recipient cannot consume an heir's claim or block other heirs", async () => {
    const f = await h.loadFixture(fixture); await f.market.write.buyReading([1n], { account: f.reader.account, value: 10000n }); await configure(f, f.author); await activate(f, f.author);
    const rejecter = await viem.deployContract("RejectingRecipient", [f.market.address]);
    const due = await f.market.read.claimableInheritedProceeds([f.author.account.address, f.heirA.account.address]);
    await assert.rejects(f.market.write.withdrawInheritedProceeds([f.author.account.address, rejecter.address], { account: f.heirA.account }));
    assert.equal(await f.market.read.claimableInheritedProceeds([f.author.account.address, f.heirA.account.address]), due);
    await f.market.write.withdrawInheritedProceeds([f.author.account.address, f.heirB.account.address], { account: f.heirB.account });
  });
  it("keeps the generated ABI current and stays below the deployment size limit", () => {
    const artifact = JSON.parse(readFileSync("artifacts/contracts/ConsentCraftReadingHeirloom.sol/ConsentCraftReadingHeirloom.json", "utf8"));
    assert.deepEqual(JSON.parse(readFileSync("abi/ConsentCraftReadingHeirloom.json", "utf8")), artifact.abi);
    assert.ok((artifact.deployedBytecode.length - 2) / 2 < 24576);
  });
});
