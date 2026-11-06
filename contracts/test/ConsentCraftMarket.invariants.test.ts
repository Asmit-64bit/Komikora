/**
 * Stateful fuzz / invariant tests.
 *
 * Each run drives a seeded random sequence of every lifecycle action (create, report,
 * appeal, resolve, finalize, timeout, publish, purchase, refund, withdraw, time travel,
 * and deliberately invalid settlement and withdrawal attempts) against the contract and
 * an independent TypeScript model. After every step it checks:
 *
 *   I1  contract balance == totalLockedDeposits + totalCredits   (balance covers liabilities)
 *   I2  totalCredits == sum of creditOf over every actor == model credits
 *   I3  totalLockedDeposits == sum over unsettled publications of (S - A)
 *   I4  every settled publication satisfies S == A + F + O, and AuthorRefund matches
 *       D = min(S, max(R, A, ceil(S/4))) computed by the model from R and A at settlement
 *   I5  each publication settles at most once (re-settlement attempts revert)
 *   I6  a withdrawal pays exactly the credit and never more (second withdrawal reverts)
 *   I7  frozen terms and Arweave IDs never change
 *
 * At the end it rebuilds a public index purely from events and compares it with contract state.
 *
 * Reproduce a failure with FUZZ_SEEDS=<seed> (comma separated) and FUZZ_STEPS=<n>.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, type Hex } from "viem";

import {
  Settlement,
  State,
  ZERO_BYTES32,
  createSamplePublication,
  deployMarket,
  randomBytes32,
  sampleReport,
  signReport,
  type Certificate,
  type Quote,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

const SEEDS = (process.env.FUZZ_SEEDS ?? "1,2,3,4").split(",").map(Number);
const STEPS = Number(process.env.FUZZ_STEPS ?? 140);

const Listing = { Unlisted: 0, Listed: 1, Delisted: 2 } as const;
const EMPTY_CERT: Certificate = { wallet: ZERO_BYTES32.slice(0, 42) as Hex, action: 0, expiresAt: 0n, nonce: 0n };

/** Short durations so time travel crosses deadlines often. Wei-scale prices. */
const FUZZ_POLICY = {
  minFee: 1n,
  feeBps: 1234,
  minPrice: 2n,
  maxPrice: 500n,
  appealDuration: 100n,
  appealResolutionDuration: 150n,
  refundDelay: 300n,
  purchaseRequiresPersonhood: false,
};

/** mulberry32: small, fast, reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    big: (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(next() * Number(hi - lo + 1n))),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}

const ceilQuarter = (s: bigint) => s / 4n + (s % 4n === 0n ? 0n : 1n);
const maxB = (...xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m));
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const fee = (p: bigint) => maxB(FUZZ_POLICY.minFee, (p * BigInt(FUZZ_POLICY.feeBps)) / 10_000n);

type ModelPub = {
  id: bigint;
  quote: Quote;
  S: bigint;
  A: bigint;
  R: bigint;
  state: number;
  listing: number;
  reason: number;
  F: bigint;
  O: bigint;
  buyers: Set<string>;
};

async function invariantFixture() {
  const f = await deployMarket(viem);
  await f.market.write.createPolicy([FUZZ_POLICY]);
  const wallets = await viem.getWalletClients();
  const buyers = [...wallets.slice(9, 15), f.author]; // includes self-purchases
  return { ...f, buyers };
}

describe("ConsentCraftMarket: stateful fuzz invariants", () => {
  for (const seed of SEEDS) {
    it(`holds every invariant over ${STEPS} random steps (seed ${seed})`, async () => {
      const f = await networkHelpers.loadFixture(invariantFixture);
      const rnd = prng(seed);
      const pubs: ModelPub[] = [];
      const credits = new Map<string, bigint>();
      // Unique wallets: the author is also a buyer (self-purchases).
      const actors = [f.author, f.owner, f.aiRecipient, ...f.buyers].filter(
        (w, i, all) => all.findIndex((x) => x.account.address === w.account.address) === i,
      );
      const key = (a: string) => getAddress(a);
      const addCredit = (a: string, v: bigint) => v > 0n && credits.set(key(a), (credits.get(key(a)) ?? 0n) + v);
      const stats: Record<string, number> = {};
      const count = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

      const latest = async () => BigInt(await networkHelpers.time.latest());
      const read = (p: ModelPub) => f.market.read.getPublication([p.id]);

      /** Credits the model's settlement and returns nothing; mirrors _settle. */
      function settle(p: ModelPub, reason: number, F: bigint, O: bigint) {
        assert.equal(p.reason, Settlement.None, `model: pub ${p.id} settled twice`);
        assert.equal(p.A + F + O, p.S, "model: S = A + F + O");
        p.reason = reason;
        p.F = F;
        p.O = O;
        addCredit(f.author.account.address, F);
        addCredit(f.owner.account.address, O);
      }

      async function expectRevert(promise: Promise<unknown>, label: string) {
        await assert.rejects(promise, Error, label);
      }

      // ------------------------------------------------------------ actions
      const actions: Record<string, () => Promise<boolean>> = {
        async create() {
          if (pubs.length >= 14) return false;
          const S = rnd.big(1n, 400n);
          const aiCap = rnd.big(0n, S - 1n);
          const price = rnd.big(FUZZ_POLICY.minPrice, FUZZ_POLICY.maxPrice);
          const pub = await createSamplePublication(f, await latest(), { policyId: 2n, deposit: S, aiCap, price });
          pubs.push({ id: pub.id, quote: pub.quote, S, A: 0n, R: 0n, state: State.Deposited, listing: Listing.Unlisted,
            reason: Settlement.None, F: 0n, O: 0n, buyers: new Set() });
          return true;
        },

        async report() {
          const p = rnd.pick(pubs.filter((x) => x.state === State.Deposited));
          if (!p) return false;
          const aiCost = rnd.chance(0.2) ? p.quote.aiCap : rnd.big(0n, p.quote.aiCap);
          const flagged = rnd.chance(0.5);
          const r = sampleReport(p.id, p.quote, { aiCost, flagged, score: rnd.int(0, 100) });
          await f.market.write.submitReviewReport([p.id, r, await signReport(f.reporter, f.chainId, f.market.address, r)]);
          p.A = aiCost;
          addCredit(f.aiRecipient.account.address, aiCost);
          p.state = flagged ? State.Flagged : State.Approved;
          return true;
        },

        async appeal() {
          const now = await latest();
          const candidates = [];
          for (const p of pubs.filter((x) => x.state === State.Flagged)) {
            if (now + 1n < (await read(p)).appealDeadline) candidates.push(p);
          }
          const p = rnd.pick(candidates);
          if (!p) return false;
          await f.market.write.appeal([p.id, randomBytes32()], { account: f.author.account });
          p.state = State.AppealPending;
          return true;
        },

        async resolve() {
          const now = await latest();
          const candidates = [];
          for (const p of pubs.filter((x) => x.state === State.AppealPending)) {
            if (now + 1n < (await read(p)).appealResolutionDeadline) candidates.push(p);
          }
          const p = rnd.pick(candidates);
          if (!p) return false;
          const approved = rnd.chance(0.5);
          await f.market.write.resolveAppeal([p.id, approved, randomBytes32()], { account: f.reviewer.account });
          if (approved) p.state = State.Approved;
          else {
            p.state = State.Rejected;
            settle(p, Settlement.Rejected, 0n, p.S - p.A);
          }
          return true;
        },

        async finalize() {
          const p = rnd.pick(pubs.filter((x) => x.state === State.Flagged));
          if (!p) return false;
          const { appealDeadline } = await read(p);
          if ((await latest()) < appealDeadline) await networkHelpers.time.increaseTo(appealDeadline);
          await f.market.write.finalizeRejection([p.id], { account: rnd.pick(f.buyers).account });
          p.state = State.Rejected;
          settle(p, Settlement.Rejected, 0n, p.S - p.A);
          return true;
        },

        async timeout() {
          const p = rnd.pick(pubs.filter((x) => x.state === State.AppealPending));
          if (!p) return false;
          const { appealResolutionDeadline } = await read(p);
          if ((await latest()) < appealResolutionDeadline) await networkHelpers.time.increaseTo(appealResolutionDeadline);
          await f.market.write.claimAppealTimeout([p.id], { account: rnd.pick(f.buyers).account });
          p.state = State.Rejected;
          settle(p, Settlement.AppealTimeout, p.S - p.A, 0n);
          return true;
        },

        async publish() {
          const p = rnd.pick(pubs.filter((x) => x.state === State.Approved));
          if (!p) return false;
          await f.market.write.publish([p.id], { account: f.author.account });
          p.state = State.Published;
          p.listing = Listing.Listed;
          return true;
        },

        async purchase() {
          const p = rnd.pick(pubs.filter((x) => x.listing === Listing.Listed));
          if (!p) return false;
          const buyer = rnd.pick(f.buyers.filter((b) => !p.buyers.has(key(b.account.address))));
          if (!buyer) return false;
          const P = p.quote.price;
          await f.market.write.purchase([p.id, randomBytes32(), EMPTY_CERT, "0x"], { account: buyer.account, value: P });
          p.buyers.add(key(buyer.account.address));
          p.R += P;
          addCredit(f.owner.account.address, fee(P));
          addCredit(f.author.account.address, P - fee(P));
          if (p.reason === Settlement.None && p.R >= p.S) settle(p, Settlement.ThresholdReached, 0n, p.S - p.A);
          return true;
        },

        async refund() {
          const p = rnd.pick(pubs.filter((x) => x.listing === Listing.Listed && x.reason === Settlement.None));
          if (!p) return false;
          const { refundEligibleAt } = await read(p);
          if ((await latest()) < refundEligibleAt) {
            if (rnd.chance(0.3)) {
              await expectRevert(f.market.write.refundAndDelist([p.id, 0n], { account: f.author.account }), "early refund");
              count("earlyRefundRejected");
              return true;
            }
            await networkHelpers.time.increaseTo(refundEligibleAt);
          }
          const D = minB(p.S, maxB(p.R, p.A, ceilQuarter(p.S)));
          const F = p.S - D;
          const O = D - p.A;
          if (rnd.chance(0.2)) {
            await expectRevert(f.market.write.refundAndDelist([p.id, F + 1n], { account: f.author.account }), "minRefund");
          }
          await f.market.write.refundAndDelist([p.id, F], { account: f.author.account });
          p.listing = Listing.Delisted;
          settle(p, Settlement.AuthorRefund, F, O);
          return true;
        },

        async withdraw() {
          const who = rnd.pick(actors);
          const addr = key(who.account.address);
          const expected = credits.get(addr) ?? 0n;
          if (expected === 0n) {
            await expectRevert(f.market.write.withdraw({ account: who.account }), "zero withdraw");
            return true;
          }
          const before = await f.publicClient.getBalance({ address: addr });
          const hash = await f.market.write.withdraw({ account: who.account });
          const r = await f.publicClient.getTransactionReceipt({ hash });
          assert.equal(await f.publicClient.getBalance({ address: addr }), before + expected - r.gasUsed * r.effectiveGasPrice, "I6 exact payout");
          credits.set(addr, 0n);
          await expectRevert(f.market.write.withdraw({ account: who.account }), "I6 second withdraw");
          return true;
        },

        async resettle() {
          // I5: every settlement entry point must refuse an already-settled deposit.
          const p = rnd.pick(pubs.filter((x) => x.reason !== Settlement.None));
          if (!p) return false;
          await networkHelpers.time.increase(1000);
          await expectRevert(f.market.write.finalizeRejection([p.id]), "resettle finalize");
          await expectRevert(f.market.write.claimAppealTimeout([p.id]), "resettle timeout");
          await expectRevert(
            f.market.write.resolveAppeal([p.id, false, randomBytes32()], { account: f.reviewer.account }),
            "resettle resolve",
          );
          await expectRevert(f.market.write.refundAndDelist([p.id, 0n], { account: f.author.account }), "resettle refund");
          return true;
        },

        async travel() {
          await networkHelpers.time.increase(rnd.int(1, 200));
          return true;
        },
      };

      const weights: [string, number][] = [
        ["create", 12], ["report", 12], ["appeal", 6], ["resolve", 5], ["finalize", 4], ["timeout", 4],
        ["publish", 10], ["purchase", 22], ["refund", 6], ["withdraw", 8], ["resettle", 4], ["travel", 5],
      ];
      const bag = weights.flatMap(([name, w]) => Array<string>(w).fill(name));

      // ------------------------------------------------------------ invariants
      async function checkInvariants(step: number, action: string) {
        const ctx = `seed ${seed} step ${step} (${action})`;
        const [balance, locked, totalCredits] = await Promise.all([
          f.publicClient.getBalance({ address: f.market.address }),
          f.market.read.totalLockedDeposits(),
          f.market.read.totalCredits(),
        ]);
        assert.equal(balance, locked + totalCredits, `I1 ${ctx}`);
        assert.equal(await f.market.read.liabilitiesCovered(), true, `I1 ${ctx}`);

        let sumCredits = 0n;
        for (const a of actors) {
          const c = await f.market.read.creditOf([a.account.address]);
          assert.equal(c, credits.get(key(a.account.address)) ?? 0n, `I2 credit ${a.account.address} ${ctx}`);
          sumCredits += c;
        }
        assert.equal(totalCredits, sumCredits, `I2 ${ctx}`);

        let expectedLocked = 0n;
        for (const p of pubs) {
          const c = await read(p);
          if (p.reason === Settlement.None) expectedLocked += p.S - p.A;
          assert.equal(c.state, p.state, `state pub ${p.id} ${ctx}`);
          assert.equal(c.listingState, p.listing, `listing pub ${p.id} ${ctx}`);
          assert.equal(c.grossSales, p.R, `R pub ${p.id} ${ctx}`);
          assert.equal(c.aiCost, p.A, `A pub ${p.id} ${ctx}`);
          assert.equal(c.settlementReason, p.reason, `reason pub ${p.id} ${ctx}`);
          assert.equal(c.authorRefund, p.F, `F pub ${p.id} ${ctx}`);
          assert.equal(c.ownerAllocation, p.O, `O pub ${p.id} ${ctx}`);
          if (p.reason !== Settlement.None) {
            assert.equal(c.aiCost + c.authorRefund + c.ownerAllocation, c.deposit, `I4 pub ${p.id} ${ctx}`);
          }
          // I7 frozen terms
          assert.equal(c.deposit, p.S, `I7 S ${ctx}`);
          assert.equal(c.price, p.quote.price, `I7 price ${ctx}`);
          assert.equal(c.aiCap, p.quote.aiCap, `I7 aiCap ${ctx}`);
          assert.equal(c.arweaveBundleTxId, p.quote.arweaveBundleTxId, `I7 bundle ${ctx}`);
          assert.equal(c.arweavePreviewTxId, p.quote.arweavePreviewTxId, `I7 preview ${ctx}`);
          assert.equal(c.manifestHash, p.quote.manifestHash, `I7 manifest ${ctx}`);
          assert.equal(c.previewManifestHash, p.quote.previewManifestHash, `I7 previewManifest ${ctx}`);
          assert.equal(c.policyId, p.quote.policyId, `I7 policy ${ctx}`);
          assert.equal(c.author, getAddress(p.quote.author), `I7 author ${ctx}`);
        }
        assert.equal(locked, expectedLocked, `I3 ${ctx}`);
      }

      // ------------------------------------------------------------ run
      for (let step = 0; step < STEPS; step++) {
        const action = rnd.pick(bag);
        if (await actions[action]()) count(action);
        await checkInvariants(step, action);
      }

      // I5 across the whole run: at most one DepositSettled per publication, and exactly one if settled.
      const settledLogs = await f.market.getEvents.DepositSettled({}, { fromBlock: 0n });
      for (const p of pubs) {
        const n = settledLogs.filter((l) => l.args.publicationId === p.id).length;
        assert.equal(n, p.reason === Settlement.None ? 0 : 1, `I5 pub ${p.id}`);
      }

      await rebuildIndexFromEvents(f, pubs);

      // The run must have exercised the interesting paths.
      for (const k of ["create", "report", "publish", "purchase", "withdraw"]) {
        assert.ok((stats[k] ?? 0) > 0, `seed ${seed} never ran ${k}: ${JSON.stringify(stats)}`);
      }
      const reasons = new Set(pubs.map((p) => p.reason));
      assert.ok(reasons.size >= 2, `seed ${seed} reached too few settlement reasons`);
    });
  }
});

/**
 * Rebuilds the public marketplace index (listings, trades, credits) from events only,
 * as an Arkiv indexer would, and checks it against contract state.
 */
async function rebuildIndexFromEvents(f: Awaited<ReturnType<typeof invariantFixture>>, pubs: ModelPub[]) {
  type Listing = {
    author: string; policyId: bigint; manifestHash: Hex; previewManifestHash: Hex; arweaveBundleTxId: Hex;
    arweavePreviewTxId: Hex; pageCount: number; price: bigint; deposit: bigint; aiCap: bigint;
    state: number; listingState: number; aiCost: bigint; score: number; reportHash: Hex; grossSales: bigint;
    settlementReason: number; authorRefund: bigint; ownerAllocation: bigint; refundEligibleAt: bigint;
    appealDeadline: bigint; appealResolutionDeadline: bigint; buyers: Set<string>;
  };
  const index = new Map<bigint, Listing>();
  const trades: { id: bigint; buyer: string; price: bigint }[] = [];
  const credits = new Map<string, bigint>();

  const logs = await f.publicClient.getContractEvents({ address: f.market.address, abi: f.market.abi, fromBlock: 0n });
  for (const log of logs) {
    const a = log.args as Record<string, never>;
    const get = () => index.get(a.publicationId)!;
    switch (log.eventName) {
      case "PublicationCreated":
        index.set(a.publicationId, {
          author: a.author, policyId: a.policyId, manifestHash: a.manifestHash, previewManifestHash: a.previewManifestHash,
          arweaveBundleTxId: a.arweaveBundleTxId, arweavePreviewTxId: a.arweavePreviewTxId, pageCount: a.pageCount,
          price: a.price, deposit: a.deposit, aiCap: a.aiCap, state: State.Deposited, listingState: Listing.Unlisted,
          aiCost: 0n, score: 0, reportHash: ZERO_BYTES32, grossSales: 0n, settlementReason: Settlement.None,
          authorRefund: 0n, ownerAllocation: 0n, refundEligibleAt: 0n, appealDeadline: 0n, appealResolutionDeadline: 0n,
          buyers: new Set(),
        });
        break;
      case "ReviewReportSubmitted":
        Object.assign(get(), { aiCost: a.aiCost, score: a.score, reportHash: a.reportHash });
        break;
      case "ReviewStatusChanged":
        get().state = a.newState;
        break;
      case "PublicationFlagged":
        get().appealDeadline = a.appealDeadline;
        break;
      case "AppealFiled":
        get().appealResolutionDeadline = a.appealResolutionDeadline;
        break;
      case "PublicationPublished":
        Object.assign(get(), { listingState: Listing.Listed, refundEligibleAt: a.refundEligibleAt });
        break;
      case "PublicationDelisted":
        get().listingState = Listing.Delisted;
        break;
      case "Purchased":
        get().grossSales = a.cumulativeGrossSales;
        get().buyers.add(a.buyer);
        trades.push({ id: a.publicationId, buyer: a.buyer, price: a.price });
        assert.equal((a.platformFee as bigint) + (a.authorProceeds as bigint), a.price as bigint, "trade split");
        break;
      case "DepositSettled":
        Object.assign(get(), {
          settlementReason: a.reason, authorRefund: a.authorRefund, ownerAllocation: a.ownerAllocation,
        });
        break;
      case "Credited":
        credits.set(a.account, (credits.get(a.account) ?? 0n) + (a.amount as bigint));
        break;
      case "Withdrawn":
        credits.set(a.account, (credits.get(a.account) ?? 0n) - (a.amount as bigint));
        break;
    }
  }

  assert.equal(index.size, pubs.length);
  for (const [id, l] of index) {
    const c = await f.market.read.getPublication([id]);
    const { buyers, ...fields } = l;
    for (const [k, v] of Object.entries(fields)) {
      assert.deepEqual(c[k as keyof typeof c], v, `index field ${k} for publication ${id}`);
    }
    for (const b of buyers) assert.equal(await f.market.read.hasReadingAccess([id, b as Hex]), true, "index buyer access");
  }
  const purchasedTotal = pubs.reduce((n, p) => n + p.buyers.size, 0);
  assert.equal(trades.length, purchasedTotal, "trade feed count");
  for (const [account, amount] of credits) {
    assert.equal(await f.market.read.creditOf([account as Hex]), amount, `index credits ${account}`);
  }
}
