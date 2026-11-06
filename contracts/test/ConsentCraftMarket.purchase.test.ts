import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, type Hex } from "viem";

import {
  Action,
  Credit,
  SAMPLE_POLICY,
  Settlement,
  State,
  ZERO_BYTES32,
  createApprovedPublication,
  createPublishedPublication,
  createSamplePublication,
  deployMarket,
  randomBytes32,
  sampleCertificate,
  sampleReport,
  signCertificate,
  signReport,
  type Certificate,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

const Listing = { Unlisted: 0, Listed: 1, Delisted: 2 } as const;
const EIP170_LIMIT = 24_576;

async function purchaseFixture() {
  const f = await deployMarket(viem);
  // Policy 2: same terms, personhood not required for purchases.
  await f.market.write.createPolicy([{ ...SAMPLE_POLICY, purchaseRequiresPersonhood: false }]);
  const buyers = (await viem.getWalletClients()).slice(9, 16);
  const now = BigInt(await networkHelpers.time.latest());
  const pub = await createPublishedPublication(f, now);
  return { ...f, buyers, pub };
}

type Fixture = Awaited<ReturnType<typeof purchaseFixture>>;
type Wallet = Fixture["author"];

describe("ConsentCraftMarket: publishing, purchases and reading access", () => {
  let f: Fixture;
  let now: bigint;

  beforeEach(async () => {
    f = await networkHelpers.loadFixture(purchaseFixture);
    now = BigInt(await networkHelpers.time.latest());
  });

  const EMPTY_CERT: Certificate = { wallet: ZERO_BYTES32.slice(0, 42) as Hex, action: 0, expiresAt: 0n, nonce: 0n };

  /** Buys `id` as `buyer`, signing a fresh PURCHASE certificate unless one is given. */
  async function buy(
    id: bigint,
    buyer: Wallet,
    opts: { requestId?: Hex; value?: bigint; cert?: Certificate; certSig?: Hex } = {},
  ) {
    const p = await f.market.read.getPublication([id]);
    const cert = opts.cert ?? sampleCertificate(buyer.account.address, now, { action: Action.Purchase });
    const certSig = opts.certSig ?? (await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert));
    return f.market.write.purchase([id, opts.requestId ?? randomBytes32(), cert, certSig], {
      account: buyer.account,
      value: opts.value ?? p.price,
    });
  }

  async function blockTime(hash: Hex) {
    const receipt = await f.publicClient.getTransactionReceipt({ hash });
    return (await f.publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  }

  async function creditOf(w: { account: { address: Hex } }) {
    return f.market.read.creditOf([w.account.address]);
  }

  async function assertBooks() {
    const balance = await f.publicClient.getBalance({ address: f.market.address });
    assert.equal(await f.market.read.totalLiabilities(), balance);
    assert.equal(await f.market.read.liabilitiesCovered(), true);
  }

  async function settledEvents(hash: Hex) {
    const { blockHash } = await f.publicClient.getTransactionReceipt({ hash });
    return f.market.getEvents.DepositSettled({}, { blockHash });
  }

  // ---------------------------------------------------------------- build

  it("stays under the EIP-170 contract size limit", async () => {
    const code = await f.publicClient.getCode({ address: f.market.address });
    assert.ok(code);
    assert.ok((code.length - 2) / 2 < EIP170_LIMIT, `runtime size ${(code.length - 2) / 2}`);
  });

  // ---------------------------------------------------------------- publish

  describe("publish", () => {
    it("lists an Approved publication and sets publishedAt and refundEligibleAt once", async () => {
      const pub = await createApprovedPublication(f, now);
      const hash = await f.market.write.publish([pub.id], { account: f.author.account });
      const ts = await blockTime(hash);
      const eligible = ts + SAMPLE_POLICY.refundDelay;

      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [pub.id, State.Approved, State.Published]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationPublished", [pub.id, pub.quote.price, eligible]);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.state, State.Published);
      assert.equal(p.listingState, Listing.Listed);
      assert.equal(p.publishedAt, ts);
      assert.equal(p.refundEligibleAt, eligible);
    });

    it("is author only", async () => {
      const pub = await createApprovedPublication(f, now);
      for (const who of [f.admin, f.reviewer, f.other, f.buyers[0]]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          f.market.write.publish([pub.id], { account: who.account }),
          f.market,
          "NotAuthor",
          [pub.id, getAddress(who.account.address)],
        );
      }
    });

    it("cannot publish twice; publishedAt is unchanged", async () => {
      const before = await f.market.read.getPublication([f.pub.id]);
      await networkHelpers.time.increase(1000);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.publish([f.pub.id], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [f.pub.id, State.Published],
      );
      const after = await f.market.read.getPublication([f.pub.id]);
      assert.equal(after.publishedAt, before.publishedAt);
      assert.equal(after.refundEligibleAt, before.refundEligibleAt);
    });

    it("requires Approved: not Deposited, Flagged or Rejected", async () => {
      const deposited = await createSamplePublication(f, now);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.publish([deposited.id], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [deposited.id, State.Deposited],
      );

      const flagged = await createSamplePublication(f, now);
      const r = sampleReport(flagged.id, flagged.quote, { flagged: true });
      await f.market.write.submitReviewReport([flagged.id, r, await signReport(f.reporter, f.chainId, f.market.address, r)]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.publish([flagged.id], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [flagged.id, State.Flagged],
      );

      await networkHelpers.time.increase(SAMPLE_POLICY.appealDuration);
      await f.market.write.finalizeRejection([flagged.id]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.publish([flagged.id], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [flagged.id, State.Rejected],
      );
    });

    it("works while paused", async () => {
      const pub = await createApprovedPublication(f, now);
      await f.market.write.pause({ account: f.pauser.account });
      await f.market.write.publish([pub.id], { account: f.author.account });
      assert.equal((await f.market.read.getPublication([pub.id])).state, State.Published);
    });
  });

  // ---------------------------------------------------------------- purchase basics

  describe("purchase", () => {
    it("grants a non-transferable entitlement, adds P to R and credits fee and proceeds", async () => {
      const buyer = f.buyers[0];
      const P = f.pub.quote.price;
      const fee = (P * BigInt(SAMPLE_POLICY.feeBps)) / 10_000n; // 0.001 ETH > minFee
      const requestId = randomBytes32();
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, buyer.account.address]), false);

      const hash = await buy(f.pub.id, buyer, { requestId });

      await viem.assertions.emitWithArgs(hash, f.market, "Purchased", [
        f.pub.id, getAddress(buyer.account.address), requestId, P, fee, P - fee, P,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "Credited", [
        getAddress(f.owner.account.address), f.pub.id, Credit.PlatformFee, fee,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "Credited", [
        getAddress(f.author.account.address), f.pub.id, Credit.SaleProceeds, P - fee,
      ]);
      assert.equal((await settledEvents(hash)).length, 0);

      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, buyer.account.address]), true);
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.buyers[1].account.address]), false);
      assert.equal(await f.market.read.isRequestIdUsed([requestId]), true);
      assert.equal((await f.market.read.getPublication([f.pub.id])).grossSales, P);
      assert.equal(await creditOf(f.owner), fee);
      assert.equal(await creditOf(f.author), P - fee);
      await assertBooks();
    });

    it("rejects buying an unpublished comic (Deposited, Approved, unknown)", async () => {
      const deposited = await createSamplePublication(f, now);
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(deposited.id, f.buyers[0], { value: deposited.quote.price }),
        f.market,
        "InvalidPublicationState",
        [deposited.id, State.Deposited],
      );
      const approved = await createApprovedPublication(f, now);
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(approved.id, f.buyers[0]),
        f.market,
        "InvalidPublicationState",
        [approved.id, State.Approved],
      );
      const cert = sampleCertificate(f.buyers[0].account.address, now, { action: Action.Purchase });
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.purchase([99n, randomBytes32(), cert, "0x"], { account: f.buyers[0].account, value: 1n }),
        f.market,
        "UnknownPublication",
        [99n],
      );
    });

    it("rejects any payment other than the exact price", async () => {
      const P = f.pub.quote.price;
      for (const value of [0n, P - 1n, P + 1n, 2n * P]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          buy(f.pub.id, f.buyers[0], { value }),
          f.market,
          "PaymentMismatch",
          [P, value],
        );
      }
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.buyers[0].account.address]), false);
    });

    it("allows one entitlement per wallet per publication", async () => {
      const buyer = f.buyers[0];
      await buy(f.pub.id, buyer);
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(f.pub.id, buyer),
        f.market,
        "AlreadyEntitled",
        [f.pub.id, getAddress(buyer.account.address)],
      );
      // The same wallet may still buy a different publication.
      const other = await createPublishedPublication(f, now);
      await buy(other.id, buyer);
      assert.equal(await f.market.read.hasReadingAccess([other.id, buyer.account.address]), true);
      assert.equal((await f.market.read.getPublication([f.pub.id])).grossSales, f.pub.quote.price);
    });

    it("rejects a reused or zero request id", async () => {
      const requestId = randomBytes32();
      await buy(f.pub.id, f.buyers[0], { requestId });
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(f.pub.id, f.buyers[1], { requestId }),
        f.market,
        "RequestIdAlreadyUsed",
        [requestId],
      );
      const other = await createPublishedPublication(f, now);
      await viem.assertions.revertWithCustomError(buy(other.id, f.buyers[1], { requestId }), f.market, "RequestIdAlreadyUsed");
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, f.buyers[1], { requestId: ZERO_BYTES32 }),
        f.market,
        "ZeroRequestId",
      );
    });

    it("allows unlimited distinct buyers", async () => {
      const P = f.pub.quote.price;
      for (const buyer of f.buyers.slice(0, 4)) await buy(f.pub.id, buyer);
      for (const buyer of f.buyers.slice(0, 4)) {
        assert.equal(await f.market.read.hasReadingAccess([f.pub.id, buyer.account.address]), true);
      }
      assert.equal((await f.market.read.getPublication([f.pub.id])).grossSales, 4n * P);
    });

    it("allows the author to buy their own comic; it counts toward R", async () => {
      const P = f.pub.quote.price;
      const fee = (P * BigInt(SAMPLE_POLICY.feeBps)) / 10_000n;
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.author.account.address]), false);
      const hash = await buy(f.pub.id, f.author);
      await viem.assertions.emitWithArgs(hash, f.market, "Purchased", [
        f.pub.id, getAddress(f.author.account.address), (x: unknown) => typeof x === "string", P, fee, P - fee, P,
      ]);
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.author.account.address]), true);
      assert.equal((await f.market.read.getPublication([f.pub.id])).grossSales, P);
      assert.equal(await creditOf(f.author), P - fee);
      await viem.assertions.revertWithCustomError(buy(f.pub.id, f.author), f.market, "AlreadyEntitled");
    });

    it("is blocked while paused and works again after unpausing", async () => {
      await f.market.write.pause({ account: f.pauser.account });
      await viem.assertions.revertWithCustomError(buy(f.pub.id, f.buyers[0]), f.market, "EnforcedPause");
      await f.market.write.unpause({ account: f.pauser.account });
      await buy(f.pub.id, f.buyers[0]);
    });

    it("does not consume the request id or certificate when it reverts", async () => {
      const requestId = randomBytes32();
      const cert = sampleCertificate(f.buyers[0].account.address, now, { action: Action.Purchase });
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, f.buyers[0], { requestId, cert, certSig, value: 1n }),
        f.market,
        "PaymentMismatch",
      );
      assert.equal(await f.market.read.isRequestIdUsed([requestId]), false);
      assert.equal(await f.market.read.isCertificateNonceUsed([cert.nonce]), false);
      await buy(f.pub.id, f.buyers[0], { requestId, cert, certSig });
    });
  });

  // ---------------------------------------------------------------- fees

  describe("fees", () => {
    it("computes f(P) = max(minFee, floor(P * feeBps / 10000))", async () => {
      const cases: [Partial<typeof SAMPLE_POLICY>, bigint, bigint][] = [
        // percentage dominates
        [{ feeBps: 1000, minFee: parseEther("0.0001") }, parseEther("0.01"), parseEther("0.001")],
        // minimum fee dominates
        [{ feeBps: 100, minFee: parseEther("0.0005") }, parseEther("0.01"), parseEther("0.0005")],
        // equal
        [{ feeBps: 1000, minFee: parseEther("0.001"), minPrice: parseEther("0.002") }, parseEther("0.01"), parseEther("0.001")],
        // floor rounding: 1000 bps of 10^16 + 9 wei = 10^15 + 0.9 wei -> 10^15
        [{ feeBps: 1000, minFee: 0n }, parseEther("0.01") + 9n, parseEther("0.001")],
        // zero fee
        [{ feeBps: 0, minFee: 0n }, parseEther("0.01"), 0n],
        // 100% fee
        [{ feeBps: 10_000, minFee: 0n }, parseEther("0.01"), parseEther("0.01")],
      ];
      for (const [policy, price, expected] of cases) {
        await f.market.write.createPolicy([{ ...SAMPLE_POLICY, ...policy }]);
        const policyId = await f.market.read.policyCount();
        assert.equal(await f.market.read.saleFee([policyId, price]), expected, `${JSON.stringify(policy, (_, v) => (typeof v === "bigint" ? v.toString() : v))} @ ${price}`);
        assert.ok(expected <= price);
      }
      await viem.assertions.revertWithCustomErrorWithArgs(f.market.read.saleFee([0n, 1n]), f.market, "UnknownPolicy", [0n]);
    });

    it("applies the minimum fee at a purchase and skips zero credits", async () => {
      // Policy 3: min fee dominates.
      await f.market.write.createPolicy([{ ...SAMPLE_POLICY, feeBps: 100, minFee: parseEther("0.0005") }]);
      const minFeePub = await createPublishedPublication(f, now, { policyId: 3n });
      const hash = await buy(minFeePub.id, f.buyers[0]);
      const P = minFeePub.quote.price;
      await viem.assertions.emitWithArgs(hash, f.market, "Purchased", [
        minFeePub.id, getAddress(f.buyers[0].account.address), (x: unknown) => typeof x === "string",
        P, parseEther("0.0005"), P - parseEther("0.0005"), P,
      ]);

      // Policy 4: 100% fee, author proceeds are zero and produce no SaleProceeds credit.
      await f.market.write.createPolicy([{ ...SAMPLE_POLICY, feeBps: 10_000, minFee: 0n, minPrice: 1n }]);
      const fullFeePub = await createPublishedPublication(f, now, { policyId: 4n });
      const hash2 = await buy(fullFeePub.id, f.buyers[0]);
      const { blockHash } = await f.publicClient.getTransactionReceipt({ hash: hash2 });
      const credits = await f.market.getEvents.Credited({}, { blockHash });
      assert.deepEqual(
        credits.map((c) => [c.args.kind, c.args.amount]),
        [[Credit.PlatformFee, fullFeePub.quote.price]],
      );
      await assertBooks();
    });
  });

  // ---------------------------------------------------------------- threshold

  describe("threshold settlement", () => {
    // Price 0.01 ETH, aiCap 0.005, A = 0.002. Three purchases add 0.03 ETH.
    const P = parseEther("0.01");
    const A = parseEther("0.002");

    async function publishWithDeposit(deposit: bigint) {
      return createPublishedPublication(f, now, { price: P, deposit, aiCap: parseEther("0.005") }, A);
    }

    async function buyN(id: bigint, n: number) {
      const hashes: Hex[] = [];
      for (const buyer of f.buyers.slice(0, n)) hashes.push(await buy(id, buyer));
      return hashes;
    }

    it("does not settle while R is just below S", async () => {
      const S = 3n * P + 1n;
      const pub = await publishWithDeposit(S);
      const hashes = await buyN(pub.id, 3);
      for (const h of hashes) assert.equal((await settledEvents(h)).length, 0);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.grossSales, S - 1n);
      assert.equal(p.settlementReason, Settlement.None);
      assert.equal(await f.market.read.totalLockedDeposits(), S - A + (f.pub.quote.deposit - f.pub.aiCost));
      await assertBooks();
    });

    it("settles S - A to the owner exactly when R equals S", async () => {
      const S = 3n * P;
      const pub = await publishWithDeposit(S);
      const [h1, h2, h3] = await buyN(pub.id, 3);
      assert.equal((await settledEvents(h1)).length, 0);
      assert.equal((await settledEvents(h2)).length, 0);

      await viem.assertions.emitWithArgs(h3, f.market, "DepositSettled", [
        pub.id, Settlement.ThresholdReached, S, A, 0n, S - A, S,
      ]);
      await viem.assertions.emitWithArgs(h3, f.market, "Credited", [
        getAddress(f.owner.account.address), pub.id, Credit.OwnerAllocation, S - A,
      ]);
      const ts = await blockTime(h3);
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.settlementReason, Settlement.ThresholdReached);
      assert.equal(p.authorRefund, 0n);
      assert.equal(p.ownerAllocation, S - A);
      assert.equal(p.aiCost + p.authorRefund + p.ownerAllocation, p.deposit);
      assert.equal(p.settledAt, ts);
      // Sales stay active and review state is unchanged.
      assert.equal(p.state, State.Published);
      assert.equal(p.listingState, Listing.Listed);
      await assertBooks();
    });

    it("settles on the purchase that takes R above S", async () => {
      const S = 3n * P - 1n;
      const pub = await publishWithDeposit(S);
      const [, h2, h3] = await buyN(pub.id, 3);
      assert.equal((await settledEvents(h2)).length, 0);
      await viem.assertions.emitWithArgs(h3, f.market, "DepositSettled", [
        pub.id, Settlement.ThresholdReached, S, A, 0n, S - A, 3n * P,
      ]);
      await assertBooks();
    });

    it("settles exactly once and later sales keep working", async () => {
      const S = 2n * P;
      const pub = await publishWithDeposit(S);
      const ownerBefore = await creditOf(f.owner);
      const hashes = await buyN(pub.id, 6);

      const settled = (await Promise.all(hashes.map(settledEvents))).flat();
      assert.equal(settled.length, 1);
      assert.equal(settled[0].transactionHash, hashes[1]);

      const fee = (P * BigInt(SAMPLE_POLICY.feeBps)) / 10_000n;
      const p = await f.market.read.getPublication([pub.id]);
      assert.equal(p.grossSales, 6n * P);
      assert.equal(p.settlementReason, Settlement.ThresholdReached);
      assert.equal(p.ownerAllocation, S - A);
      assert.equal(p.listingState, Listing.Listed);
      assert.equal(await creditOf(f.owner), ownerBefore + 6n * fee + (S - A));
      for (const buyer of f.buyers.slice(0, 6)) {
        assert.equal(await f.market.read.hasReadingAccess([pub.id, buyer.account.address]), true);
      }
      await viem.assertions.emitWithArgs(hashes[5], f.market, "Purchased", [
        pub.id, getAddress(f.buyers[5].account.address), (x: unknown) => typeof x === "string", P, fee, P - fee, 6n * P,
      ]);
      await assertBooks();
    });

    it("counts self-purchases toward the threshold", async () => {
      const S = 2n * P;
      const pub = await publishWithDeposit(S);
      await buy(pub.id, f.buyers[0]);
      const hash = await buy(pub.id, f.author);
      assert.equal((await settledEvents(hash)).length, 1);
    });

    it("credits the full deposit to the owner when A is zero", async () => {
      const S = P;
      const pub = await createPublishedPublication(f, now, { price: P, deposit: S, aiCap: parseEther("0.005") }, 0n);
      const hash = await buy(pub.id, f.buyers[0]);
      await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [
        pub.id, Settlement.ThresholdReached, S, 0n, 0n, S, S,
      ]);
    });
  });

  // ---------------------------------------------------------------- certificates

  describe("purchase certificates", () => {
    it("are required and consumed when the policy requires personhood", async () => {
      const buyer = f.buyers[0];
      const cert = sampleCertificate(buyer.account.address, now, { action: Action.Purchase });
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await buy(f.pub.id, buyer, { cert, certSig });
      assert.equal(await f.market.read.isCertificateNonceUsed([cert.nonce]), true);

      // Replay by the same wallet on another publication.
      const other = await createPublishedPublication(f, now);
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(other.id, buyer, { cert, certSig }),
        f.market,
        "CertificateNonceUsed",
        [cert.nonce],
      );
    });

    it("rejects missing, wrong-wallet, PUBLISH, expired, unsigned or tampered certificates when required", async () => {
      const buyer = f.buyers[0];
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, buyer, { cert: EMPTY_CERT, certSig: "0x" }),
        f.market,
        "CertificateWalletMismatch",
      );
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, buyer, { cert: sampleCertificate(f.buyers[1].account.address, now, { action: Action.Purchase }) }),
        f.market,
        "CertificateWalletMismatch",
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        buy(f.pub.id, buyer, { cert: sampleCertificate(buyer.account.address, now, { action: Action.Publish }) }),
        f.market,
        "CertificateActionMismatch",
        [Action.Purchase, Action.Publish],
      );

      const expiring = sampleCertificate(buyer.account.address, now, { action: Action.Purchase, expiresAt: now + 5n });
      const expiringSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, expiring);
      await networkHelpers.time.setNextBlockTimestamp(now + 6n);
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, buyer, { cert: expiring, certSig: expiringSig }),
        f.market,
        "CertificateExpired",
      );

      const cert = sampleCertificate(buyer.account.address, now + 100n, { action: Action.Purchase });
      const wrongSig = await signCertificate(f.other, f.chainId, f.market.address, cert);
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, buyer, { cert, certSig: wrongSig }),
        f.market,
        "InvalidCertificateSignature",
      );
      const goodSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await viem.assertions.revertWithCustomError(
        buy(f.pub.id, buyer, { cert: { ...cert, nonce: cert.nonce + 1n }, certSig: goodSig }),
        f.market,
        "InvalidCertificateSignature",
      );
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, buyer.account.address]), false);
    });

    it("are ignored and not consumed when the policy does not require personhood", async () => {
      const pub = await createPublishedPublication(f, now, { policyId: 2n });
      await buy(pub.id, f.buyers[0], { cert: EMPTY_CERT, certSig: "0x" });
      assert.equal(await f.market.read.hasReadingAccess([pub.id, f.buyers[0].account.address]), true);

      // A valid certificate passed anyway is not consumed.
      const cert = sampleCertificate(f.buyers[1].account.address, now, { action: Action.Purchase });
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await buy(pub.id, f.buyers[1], { cert, certSig });
      assert.equal(await f.market.read.isCertificateNonceUsed([cert.nonce]), false);
    });
  });

  // ---------------------------------------------------------------- reading access

  describe("hasReadingAccess", () => {
    it("is false without an entitlement, for any publication id", async () => {
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.buyers[0].account.address]), false);
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.author.account.address]), false);
      assert.equal(await f.market.read.hasReadingAccess([999n, f.buyers[0].account.address]), false);
    });

    it("is per publication and per wallet", async () => {
      const other = await createPublishedPublication(f, now);
      await buy(f.pub.id, f.buyers[0]);
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.buyers[0].account.address]), true);
      assert.equal(await f.market.read.hasReadingAccess([other.id, f.buyers[0].account.address]), false);
      assert.equal(await f.market.read.hasReadingAccess([f.pub.id, f.buyers[1].account.address]), false);
    });

    it("persists after the deposit settles and while the contract is paused", async () => {
      const pub = await createPublishedPublication(f, now, { price: parseEther("0.01"), deposit: parseEther("0.01"), aiCap: 1n }, 0n);
      await buy(pub.id, f.buyers[0]);
      assert.equal((await f.market.read.getPublication([pub.id])).settlementReason, Settlement.ThresholdReached);
      await f.market.write.pause({ account: f.pauser.account });
      assert.equal(await f.market.read.hasReadingAccess([pub.id, f.buyers[0].account.address]), true);
    });
  });
});
