import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, pad, toHex } from "viem";

const { viem } = await network.create();
const id = (n: number) => pad(toHex(n), { size: 32 });

async function fixture() {
  const [admin, relayer, other] = await viem.getWalletClients();
  const registry = await viem.deployContract("ComicRatingRegistry", [admin.account.address, relayer.account.address, 2]);
  return { admin, relayer, other, registry };
}

describe("ComicRatingRegistry", () => {
  it("emits submissions and ratings, preserves versions and computes medians and spreads", async () => {
    const { registry: r, relayer } = await fixture();
    await viem.assertions.emitWithArgs(r.write.submitComic([id(10), "arweave", id(11)]), r, "ComicSubmitted", [1n, id(10), "arweave", id(11), getAddress((await viem.getWalletClients())[0].account.address)]);
    assert.deepEqual(await r.read.getComic([1n]), { comicHash: id(10), arkivKey: id(11), arweaveId: "arweave" });
    const post = (v: bigint, ids: `0x${string}`[], scores: number[]) => r.write.postRating([1n, v, ids, scores, id(99), "evidence"], { account: relayer.account });
    await viem.assertions.emitWithArgs(post(9n, [id(1), id(2), id(3)], [100, 0, 51]), r, "RatingPosted", [1n, 9n, 51, 100, getAddress(relayer.account.address)]);
    await viem.assertions.revertWithCustomError(post(9n, [id(1), id(2)], [0, 100]), r, "RatingAlreadyExists");
    await post(0n, [id(1), id(2)], [0, 99]);
    const old = await r.read.getRating([1n, 9n]);
    assert.equal(old.finalScore, 51); assert.equal(old.spread, 100);
    assert.deepEqual(old.jurorScores, [100, 0, 51]);
    assert.equal(old.evidenceHash, id(99)); assert.equal(old.evidenceURI, "evidence");
    assert.equal(old.relayer, getAddress(relayer.account.address)); assert.ok(old.timestamp > 0n);
    const [version, latest] = await r.read.getLatestRating([1n]);
    assert.equal(version, 0n); assert.equal(latest.finalScore, 49); assert.equal(latest.spread, 99);
  });

  it("enforces roles, validation, panel configuration and pause", async () => {
    const { registry: r, other, relayer } = await fixture();
    const args = [1n, 1n, [id(1), id(2)], [0, 100], id(3), "uri"] as const;
    await viem.assertions.revertWithCustomError(r.write.postRating(args, { account: other.account }), r, "AccessControlUnauthorizedAccount");
    await viem.assertions.revertWithCustomError(r.write.postRating(args, { account: relayer.account }), r, "ComicNotFound");
    await viem.assertions.revertWithCustomError(r.read.getLatestRating([1n]), r, "RatingNotFound");
    await r.write.submitComic([id(1), "a", id(2)]);
    const post = (ids: `0x${string}`[], scores: number[]) => r.write.postRating([1n, 1n, ids, scores, id(3), "uri"], { account: relayer.account });
    await viem.assertions.revertWithCustomError(post([id(1)], [1, 2]), r, "ArrayLengthMismatch");
    await viem.assertions.revertWithCustomError(post([id(1)], [1]), r, "InvalidPanelSize");
    await viem.assertions.revertWithCustomError(post(Array.from({length: 10}, (_, i) => id(i)), Array(10).fill(1)), r, "InvalidPanelSize");
    await viem.assertions.revertWithCustomError(post([id(1), id(1)], [1, 2]), r, "DuplicateJuror");
    await viem.assertions.revertWithCustomError(post([id(1), id(2)], [0, 101]), r, "InvalidScore");
    await viem.assertions.revertWithCustomError(r.write.setMinimumPanelSize([0]), r, "InvalidPanelSize");
    await viem.assertions.revertWithCustomError(r.write.pause({ account: other.account }), r, "AccessControlUnauthorizedAccount");
    await viem.assertions.emit(r.write.pause(), r, "Paused");
    await viem.assertions.revertWithCustomError(post([id(1), id(2)], [0, 100]), r, "EnforcedPause");
    await viem.assertions.revertWithCustomError(r.write.submitComic([id(1), "a", id(2)]), r, "EnforcedPause");
    await viem.assertions.emit(r.write.unpause(), r, "Unpaused");
    await viem.assertions.emitWithArgs(r.write.setMinimumPanelSize([1]), r, "MinimumPanelSizeUpdated", [2, 1]);
    await post([id(1)], [100]);
    assert.equal((await r.read.getRating([1n, 1n])).finalScore, 100);
  });
});

it("exports the compiled registry ABI", async () => {
  const { readFileSync } = await import("node:fs");
  const artifact = JSON.parse(readFileSync("artifacts/contracts/ComicRatingRegistry.sol/ComicRatingRegistry.json", "utf8")) as { abi: unknown };
  const exported = JSON.parse(readFileSync("abi/ComicRatingRegistry.json", "utf8")) as unknown;
  assert.deepEqual(exported, artifact.abi);
});
