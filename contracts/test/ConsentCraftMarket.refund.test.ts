import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, toFunctionSelector, type Hex } from "viem";

import {
  Credit,
  SAMPLE_POLICY,
  Settlement,
  State,
  ZERO_BYTES32,
  createApprovedPublication,
  createPublishedPublication,
  deployMarket,
  randomBytes32,
  type Certificate,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

const Listing = { Unlisted: 0, Listed: 1, Delisted: 2 } as const;
const EMPTY_CERT: Certificate = { wallet: ZERO_BYTES32.slice(0, 42) as Hex, action: 0, expiresAt: 0n, nonce: 0n };

/** Wei-scale policy (id 2) so the report's abstract accounting units can be used literally. */
const WEI_POLICY = {
  ...SAMPLE_POLICY,
  minFee: 0n,
  feeBps: 1000,
  minPrice: 1n,
  maxPrice: 1000n,
  purchaseRequiresPersonhood: false,
};

async function refundFixture() {
  const f = await deployMarket(viem);
  await f.market.write.createPolicy([WEI_POLICY]);
  const buyers = (await viem.getWalletClients()).slice(9, 17);
  return { ...f, buyers };
}

type Fixture = Awaited<ReturnType<typeof refundFixture>>;
type Wallet = Fixture["author"];

describe("ConsentCraftMarket: refunds, delisting and withdrawals", () => {
  let f: Fixture;
  let now: bigint;

  beforeEach(async () => {
    f = await networkHelpers.loadFixture(refundFixture);
    now = BigInt(await networkHelpers.time.latest());
  });

  // ---------------------------------------------------------------- helpers

  /** Published publication under the wei policy with deposit S, review cost A and copy price. */
  function publish(S: bigint, A: bigint, price = 20n, aiCap = 50n) {
    return createPublishedPublication(f, now, { policyId: 2n, deposit: S, aiCap: aiCap < S ? aiCap : S - 1n, price }, A);
  }

  function buy(id: bigint, buyer: Wallet, value?: bigint) {
    return f.market.read.getPublication([id]).then((p) =>
      f.market.write.purchase([id, randomBytes32(), EMPTY_CERT, "0x"], { account: buyer.account, value: value ?? p.price }),
    );
  }

  async function buyN(id: bigint, n: number) {
    for (const buyer of f.buyers.slice(0, n)) await buy(id, buyer);
  }

  async function atEligibility(id: bigint, offset = 0n) {
    const { refundEligibleAt } = await f.market.read.getPublication([id]);
    await networkHelpers.time.setNextBlockTimestamp(refundEligibleAt + offset);
    return refundEligibleAt;
  }

  function refund(id: bigint, minRefund = 0n, from: Wallet = f.author) {
    return f.market.write.refundAndDelist([id, minRefund], { account: from.account });
  }

  async function credit(addr: Hex) {
    return f.market.read.creditOf([addr]);
  }

  async function assertBooks() {
    const balance = await f.publicClient.getBalance({ address: f.market.address });
    assert.equal(await f.market.read.totalLiabilities(), balance);
    assert.equal(await f.market.read.liabilitiesCovered(), true);
  }

  // ---------------------------------------------------------------- report accounting cases

  describe("report accounting cases", () => {
    const refundCases = [
      { S: 100n, R: 0n, A: 10n, F: 75n, O: 15n },
      { S: 100n, R: 60n, A: 10n, F: 40n, O: 50n },
      { S: 100n, R: 20n, A: 40n, F: 60n, O: 0n },
    ];

    for (const c of refundCases) {
      it(`AuthorRefund: S=${c.S}, R=${c.R}, A=${c.A} gives F=${c.F}, O=${c.O}`, async () => {
        const pub = await publish(c.S, c.A);
        await buyN(pub.id, Number(c.R / 20n));
        assert.equal((await f.market.read.getPublication([pub.id])).grossSales, c.R);

        const D = c.S - c.F;
        assert.deepEqual(await f.market.read.previewSettlement([pub.id]), [D, c.F, c.O]);

        const authorBefore = await credit(f.author.account.address);
        const ownerBefore = await credit(f.owner.account.address);
        const lockedBefore = await f.market.read.totalLockedDeposits();
        assert.equal(lockedBefore, c.S - c.A, "A was unlocked at review");

        await atEligibility(pub.id);
        const hash = await refund(pub.id, c.F);

        await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [
          pub.id, Settlement.AuthorRefund, c.S, c.A, c.F, c.O, c.R,
        ]);
        await viem.assertions.emitWithArgs(hash, f.market, "PublicationDelisted", [pub.id]);
        const p = await f.market.read.getPublication([pub.id]);
        assert.equal(p.settlementReason, Settlement.AuthorRefund);
        assert.equal(p.authorRefund, c.F);
        assert.equal(p.ownerAllocation, c.O);
        assert.equal(p.aiCost + p.authorRefund + p.ownerAllocation, p.deposit, "S = A + F + O");

        // A is not deducted again: credits move by exactly F and O.
        assert.equal(await credit(f.author.account.address), authorBefore + c.F);
        assert.equal(await credit(f.owner.account.address), ownerBefore + c.O);
        assert.equal(await credit(f.aiRecipient.account.address), c.A);
        assert.equal(await f.market.read.totalLockedDeposits(), lockedBefore - c.F - c.O);
        assert.equal(await f.market.read.totalLockedDeposits(), 0n);
        await assertBooks();
      });
    }

    it("O = 0 produces no OwnerAllocation credit event", async () => {
      const pub = await publish(100n, 40n);
      await buyN(pub.id, 1);
      await atEligibility(pub.id);
      const hash = await refund(pub.id);
      const { blockHash } = await f.publicClient.getTransactionReceipt({ hash });
      const credits = await f.market.getEvents.Credited({}, { blockHash });
      assert.deepEqual(
        credits.map((e) => [e.args.kind, e.args.amount]),
        [[Credit.DepositRefund, 60n]],
      );
    });

    it("ThresholdReached: S=100, R=100, A=10 gives F=0, O=90", async () => {
      const pub = await publish(100n, 10n);
      await buyN(pub.id, 4);
      const ownerBefore = await credit(f.owner.account.address);
      const hash = await buy(pub.id, f.buyers[4]);
      await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [
        pub.id, Settlement.ThresholdReached, 100n, 10n, 0n, 90n, 100n,
      ]);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.authorRefund, 0n);
      assert.equal(p.ownerAllocation, 90n);
      // Owner also received the 10% fee (2 wei) from this sale.
      assert.equal(await credit(f.owner.account.address), ownerBefore + 90n + 2n);
      await assertBooks();
    });
  });

  // ---------------------------------------------------------------- rounding

  describe("ceil(S / 4) rounding", () => {
    // With R = 0 and A = 0, D = Q, so F = S - ceil(S/4) and O = ceil(S/4).
    const cases: [bigint, bigint][] = [
      [1n, 1n],
      [2n, 1n],
      [3n, 1n],
      [4n, 1n],
      [5n, 2n],
      [100n, 25n],
      [101n, 26n],
      [102n, 26n],
      [103n, 26n],
      [104n, 26n],
      [parseEther("1") + 1n, parseEther("0.25") + 1n],
    ];
    for (const [S, Q] of cases) {
      it(`S=${S} gives Q=${Q}`, async () => {
        const pub = await createPublishedPublication(
          f,
          now,
          { policyId: 2n, deposit: S, aiCap: 0n, price: 1000n },
          0n,
        );
        assert.deepEqual(await f.market.read.previewSettlement([pub.id]), [Q, S - Q, Q]);
        await atEligibility(pub.id);
        await refund(pub.id, S - Q);
        const p = await f.market.read.getPublication([pub.id]);
        assert.equal(p.authorRefund, S - Q);
        assert.equal(p.ownerAllocation, Q);
      });
    }
  });

  // ---------------------------------------------------------------- eligibility and guards

  describe("refundAndDelist guards", () => {
    it("fails one second before eligibility and succeeds exactly at it", async () => {
      const pub = await publish(100n, 10n);
      const eligible = await atEligibility(pub.id, -1n);
      await viem.assertions.revertWithCustomErrorWithArgs(refund(pub.id), f.market, "RefundNotYetAvailable", [
        pub.id,
        eligible,
      ]);
      await networkHelpers.time.setNextBlockTimestamp(eligible);
      const hash = await refund(pub.id);
      const receipt = await f.publicClient.getTransactionReceipt({ hash });
      const block = await f.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      assert.equal(block.timestamp, eligible);
      assert.equal((await f.market.read.getPublication([pub.id])).settledAt, eligible);
    });

    it("eligibility is publishedAt + refundDelay", async () => {
      const pub = await publish(100n, 10n);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.refundEligibleAt, p.publishedAt + SAMPLE_POLICY.refundDelay);
    });

    it("rejects a refund after threshold settlement", async () => {
      const pub = await publish(100n, 10n);
      await buyN(pub.id, 5);
      await atEligibility(pub.id);
      await viem.assertions.revertWithCustomErrorWithArgs(refund(pub.id), f.market, "DepositAlreadySettled", [
        pub.id,
        Settlement.ThresholdReached,
      ]);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.listingState, Listing.Listed);
      assert.equal(p.settlementReason, Settlement.ThresholdReached);
    });

    it("rejects a refund by anyone but the author", async () => {
      const pub = await publish(100n, 10n);
      await atEligibility(pub.id);
      for (const who of [f.owner, f.admin, f.buyers[0], f.reviewer]) {
        await viem.assertions.revertWithCustomErrorWithArgs(refund(pub.id, 0n, who), f.market, "NotAuthor", [
          pub.id,
          getAddress(who.account.address),
        ]);
      }
    });

    it("rejects a refund before publication and a second refund", async () => {
      const approved = await createApprovedPublication(f, now, { policyId: 2n, deposit: 100n, aiCap: 50n, price: 20n }, 10n);
      await viem.assertions.revertWithCustomErrorWithArgs(refund(approved.id), f.market, "InvalidPublicationState", [
        approved.id,
        State.Approved,
      ]);

      const pub = await publish(100n, 10n);
      await atEligibility(pub.id);
      await refund(pub.id);
      await viem.assertions.revertWithCustomErrorWithArgs(refund(pub.id), f.market, "InvalidListingState", [
        pub.id,
        Listing.Delisted,
      ]);
    });

    it("minRefund protects the author against a sale between preview and refund", async () => {
      const pub = await publish(100n, 10n);
      await buyN(pub.id, 1); // R = 20 < Q = 25
      const [, previewF] = await f.market.read.previewSettlement([pub.id]);
      assert.equal(previewF, 75n);

      await buy(pub.id, f.buyers[5]); // R = 40 -> F = 60
      await atEligibility(pub.id);
      await viem.assertions.revertWithCustomErrorWithArgs(refund(pub.id, previewF), f.market, "RefundBelowMinimum", [
        60n,
        75n,
      ]);
      assert.equal((await f.market.read.getPublication([pub.id])).listingState, Listing.Listed);

      await refund(pub.id, 60n); // exactly F is accepted
      assert.equal((await f.market.read.getPublication([pub.id])).authorRefund, 60n);
    });

    it("works while paused", async () => {
      const pub = await publish(100n, 10n);
      await f.market.write.pause({ account: f.pauser.account });
      await atEligibility(pub.id);
      await refund(pub.id);
      assert.equal((await f.market.read.getPublication([pub.id])).settlementReason, Settlement.AuthorRefund);
    });
  });

  // ---------------------------------------------------------------- after delisting

  describe("after delisting", () => {
    it("blocks purchases, keeps reading access and leaves Arweave IDs and frozen terms unchanged", async () => {
      const pub = await publish(100n, 10n);
      await buyN(pub.id, 2);
      const before = await f.market.read.getPublication([pub.id]);
      await atEligibility(pub.id);
      const hash = await refund(pub.id);
      const ts = (await f.publicClient.getBlock({ blockNumber: (await f.publicClient.getTransactionReceipt({ hash })).blockNumber })).timestamp;

      await viem.assertions.revertWithCustomErrorWithArgs(buy(pub.id, f.buyers[3]), f.market, "InvalidListingState", [
        pub.id,
        Listing.Delisted,
      ]);
      for (const buyer of f.buyers.slice(0, 2)) {
        assert.equal(await f.market.read.hasReadingAccess([pub.id, buyer.account.address]), true);
      }
      assert.equal(await f.market.read.hasReadingAccess([pub.id, f.buyers[3].account.address]), false);

      const after = await f.market.read.getPublication([pub.id]);
      assert.equal(after.listingState, Listing.Delisted);
      assert.equal(after.delistedAt, ts);
      assert.equal(after.state, State.Published, "review state is unchanged");
      for (const field of [
        "author", "policyId", "manifestHash", "previewManifestHash", "arweaveBundleTxId", "arweavePreviewTxId",
        "pageCount", "ratingSnapshot", "price", "deposit", "aiCap", "aiCost", "grossSales", "publishedAt",
      ] as const) {
        assert.deepEqual(after[field], before[field], field);
      }
      assert.equal(after.arweaveBundleTxId, pub.quote.arweaveBundleTxId);
      assert.equal(after.arweavePreviewTxId, pub.quote.arweavePreviewTxId);
    });
  });

  // ---------------------------------------------------------------- withdrawals

  describe("withdraw", () => {
    async function gasCost(hash: Hex) {
      const r = await f.publicClient.getTransactionReceipt({ hash });
      return r.gasUsed * r.effectiveGasPrice;
    }

    /** Sale proceeds and AI credit from one published, sold sample publication. */
    async function earn() {
      const pub = await publish(100n, 10n);
      await buyN(pub.id, 2);
      return pub;
    }

    it("pays the full credit to the caller, zeroes it and emits Withdrawn", async () => {
      await earn();
      const addr = f.author.account.address;
      const amount = await credit(addr); // 2 sales x (20 - 2)
      assert.equal(amount, 36n);
      const ethBefore = await f.publicClient.getBalance({ address: addr });
      const marketBefore = await f.publicClient.getBalance({ address: f.market.address });
      const totalBefore = await f.market.read.totalCredits();

      const hash = await f.market.write.withdraw({ account: f.author.account });
      await viem.assertions.emitWithArgs(hash, f.market, "Withdrawn", [getAddress(addr), amount]);
      assert.equal(await f.publicClient.getBalance({ address: addr }), ethBefore + amount - (await gasCost(hash)));
      assert.equal(await f.publicClient.getBalance({ address: f.market.address }), marketBefore - amount);
      assert.equal(await credit(addr), 0n);
      assert.equal(await f.market.read.totalCredits(), totalBefore - amount);
      await assertBooks();
    });

    it("withdrawing twice fails the second time", async () => {
      await earn();
      await f.market.write.withdraw({ account: f.author.account });
      await viem.assertions.revertWithCustomError(f.market.write.withdraw({ account: f.author.account }), f.market, "NothingToWithdraw");
    });

    it("reverts for accounts with zero credit", async () => {
      for (const who of [f.other, f.admin, f.buyers[0]]) {
        await viem.assertions.revertWithCustomError(f.market.write.withdraw({ account: who.account }), f.market, "NothingToWithdraw");
      }
    });

    it("works while paused, for every beneficiary", async () => {
      const pub = await earn();
      await atEligibility(pub.id);
      await refund(pub.id);
      await f.market.write.pause({ account: f.pauser.account });
      for (const who of [f.author, f.owner, f.aiRecipient]) {
        await f.market.write.withdraw({ account: who.account });
        assert.equal(await credit(who.account.address), 0n);
      }
      // Everything owed for this publication has been paid out.
      assert.equal(await f.market.read.totalCredits(), 0n);
      assert.equal(await f.market.read.totalLockedDeposits(), 0n);
      assert.equal(await f.publicClient.getBalance({ address: f.market.address }), 0n);
    });

    it("cannot withdraw another account's credit", async () => {
      await earn();
      const authorCredit = await credit(f.author.account.address);
      await viem.assertions.revertWithCustomError(f.market.write.withdraw({ account: f.other.account }), f.market, "NothingToWithdraw");
      assert.equal(await credit(f.author.account.address), authorCredit);
    });

    it("blocks a reentrant recipient and pays it exactly once", async () => {
      const attacker = await viem.deployContract("ReentrantRecipient", [f.market.address]);
      await f.market.write.setOwnerRecipient([attacker.address]);
      await earn(); // owner (attacker) earns 2 x 2 wei in fees
      const amount = await credit(attacker.address);
      assert.equal(amount, 4n);
      const marketBefore = await f.publicClient.getBalance({ address: f.market.address });

      await attacker.write.withdrawFromMarket();
      assert.equal(await attacker.read.reentryAttempts(), 1n);
      assert.equal(
        (await attacker.read.lastReentryError()).slice(0, 10),
        toFunctionSelector("ReentrancyGuardReentrantCall()"),
      );
      assert.equal(await f.publicClient.getBalance({ address: attacker.address }), amount);
      assert.equal(await f.publicClient.getBalance({ address: f.market.address }), marketBefore - amount);
      assert.equal(await credit(attacker.address), 0n);
      await assertBooks();
    });

    it("reverts and preserves the credit when the recipient rejects ETH", async () => {
      const rejecting = await viem.deployContract("RejectingRecipient", [f.market.address]);
      await f.market.write.setOwnerRecipient([rejecting.address]);
      await earn();
      const amount = await credit(rejecting.address);
      assert.equal(amount, 4n);
      const totalBefore = await f.market.read.totalCredits();

      await viem.assertions.revertWithCustomErrorWithArgs(
        rejecting.write.withdrawFromMarket(),
        f.market,
        "WithdrawalFailed",
        [getAddress(rejecting.address), amount],
      );
      assert.equal(await credit(rejecting.address), amount);
      assert.equal(await f.market.read.totalCredits(), totalBefore);
      await assertBooks();

      // Other beneficiaries are unaffected.
      await f.market.write.withdraw({ account: f.author.account });

      // Once it accepts ETH, the preserved credit can be withdrawn.
      await rejecting.write.setAccepting([true]);
      await rejecting.write.withdrawFromMarket();
      assert.equal(await credit(rejecting.address), 0n);
      assert.equal(await f.publicClient.getBalance({ address: rejecting.address }), amount);
    });
  });
});
