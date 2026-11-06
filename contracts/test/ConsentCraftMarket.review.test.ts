import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, parseEther, toHex, type Hex } from "viem";

import {
  Credit,
  OTHER_TX_ID,
  Path,
  SAMPLE_POLICY,
  Settlement,
  State,
  createSamplePublication,
  deployMarket,
  randomBytes32,
  roleId,
  sampleReport,
  signReport,
  type Report,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

async function reviewFixture() {
  const f = await deployMarket(viem);
  const now = BigInt(await networkHelpers.time.latest());
  const pub = await createSamplePublication(f, now);
  return { ...f, ...pub };
}

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;

const EVIDENCE = keccak256(toHex("appeal evidence"));
const REASON = keccak256(toHex("reviewer reasons"));

describe("ConsentCraftMarket: review reports and appeals", () => {
  let f: Fixture;
  let S: bigint;

  beforeEach(async () => {
    f = await networkHelpers.loadFixture(reviewFixture);
    S = f.quote.deposit;
  });

  // ---------------------------------------------------------------- helpers

  async function submit(report: Report, opts: { signer?: Fixture["reporter"]; from?: Fixture["other"]; id?: bigint } = {}) {
    const sig = await signReport(opts.signer ?? f.reporter, f.chainId, f.market.address, report);
    return f.market.write.submitReviewReport([opts.id ?? report.publicationId, report, sig], {
      account: (opts.from ?? f.other).account,
    });
  }

  const report = (overrides: Partial<Report> = {}) => sampleReport(f.id, f.quote, overrides);

  async function blockTime(hash: Hex) {
    const receipt = await f.publicClient.getTransactionReceipt({ hash });
    return (await f.publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  }

  /** Flags the sample publication and returns its appeal deadline. */
  async function flag(aiCost = parseEther("0.002")) {
    await submit(report({ flagged: true, aiCost }));
    return (await f.market.read.getPublication([f.id])).appealDeadline;
  }

  /** Flags and appeals; returns the resolution deadline. */
  async function flagAndAppeal(aiCost?: bigint) {
    await flag(aiCost);
    await f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account });
    return (await f.market.read.getPublication([f.id])).appealResolutionDeadline;
  }

  async function at(timestamp: bigint) {
    await networkHelpers.time.setNextBlockTimestamp(timestamp);
  }

  async function credits() {
    const [ai, owner, author] = await Promise.all([
      f.market.read.creditOf([f.aiRecipient.account.address]),
      f.market.read.creditOf([f.owner.account.address]),
      f.market.read.creditOf([f.author.account.address]),
    ]);
    return { ai, owner, author };
  }

  /** Books balance: every wei held is either locked or credited, and credits add up. */
  async function assertBooks() {
    const balance = await f.publicClient.getBalance({ address: f.market.address });
    const c = await credits();
    assert.equal(await f.market.read.totalCredits(), c.ai + c.owner + c.author);
    assert.equal(await f.market.read.totalLiabilities(), balance);
    assert.equal(await f.market.read.liabilitiesCovered(), true);
  }

  async function assertSettled(reason: number, authorRefund: bigint, ownerAllocation: bigint) {
    const p = await f.market.read.getPublication([f.id]);
    assert.equal(p.state, State.Rejected);
    assert.equal(p.settlementReason, reason);
    assert.equal(p.authorRefund, authorRefund);
    assert.equal(p.ownerAllocation, ownerAllocation);
    assert.equal(p.aiCost + p.authorRefund + p.ownerAllocation, p.deposit, "S = A + F + O");
    assert.notEqual(p.settledAt, 0n);
    assert.equal(await f.market.read.totalLockedDeposits(), 0n);
    await assertBooks();
  }

  // ---------------------------------------------------------------- reports

  describe("submitReviewReport", () => {
    it("approves on an unflagged report, recognizes A once and credits the AI recipient", async () => {
      const r = report();
      const hash = await submit(r);
      const ts = await blockTime(hash);

      await viem.assertions.emitWithArgs(hash, f.market, "ReviewReportSubmitted", [
        f.id, r.jobId, false, r.score, r.aiCost, r.reportHash, r.modelVersion, r.promptVersion,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "Credited", [
        getAddress(f.aiRecipient.account.address), f.id, Credit.AiExpense, r.aiCost,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [f.id, State.Deposited, State.Approved]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationApproved", [f.id, Path.Report]);

      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.state, State.Approved);
      assert.equal(p.aiCost, r.aiCost);
      assert.equal(p.score, r.score);
      assert.equal(p.reportHash, r.reportHash);
      assert.equal(p.reviewedAt, ts);
      assert.equal(p.decidedAt, ts);
      assert.equal(p.flaggedAt, 0n);
      assert.equal(p.appealDeadline, 0n);
      assert.equal(p.settlementReason, Settlement.None);

      assert.equal((await credits()).ai, r.aiCost);
      assert.equal(await f.market.read.totalLockedDeposits(), S - r.aiCost);
      assert.equal(await f.market.read.isJobIdUsed([r.jobId]), true);
      await assertBooks();
    });

    it("flags on a flagged report and records flaggedAt and appealDeadline", async () => {
      const r = report({ flagged: true, score: 3 });
      const hash = await submit(r);
      const ts = await blockTime(hash);
      const deadline = ts + SAMPLE_POLICY.appealDuration;

      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [f.id, State.Deposited, State.Flagged]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationFlagged", [f.id, ts, deadline]);

      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.state, State.Flagged);
      assert.equal(p.flaggedAt, ts);
      assert.equal(p.appealDeadline, deadline);
      assert.equal(p.decidedAt, 0n);
      assert.equal(p.aiCost, r.aiCost);
      assert.equal((await credits()).ai, r.aiCost);
      assert.equal(await f.market.read.totalLockedDeposits(), S - r.aiCost);
      await assertBooks();
    });

    it("accepts aiCost equal to aiCap and aiCost of zero (no zero credit emitted)", async () => {
      await submit(report({ aiCost: f.quote.aiCap }));
      assert.equal((await credits()).ai, f.quote.aiCap);

      const second = await createSamplePublication(f, BigInt(await networkHelpers.time.latest()));
      const hash = await submit(sampleReport(second.id, second.quote, { aiCost: 0n }));
      const logs = await f.market.getEvents.Credited({}, { blockHash: (await f.publicClient.getTransactionReceipt({ hash })).blockHash });
      assert.equal(logs.length, 0);
      assert.equal((await f.market.read.getPublication([second.id])).state, State.Approved);
      assert.equal((await credits()).ai, f.quote.aiCap);
    });

    it("may be relayed by any account, including while paused", async () => {
      await f.market.write.pause({ account: f.pauser.account });
      await submit(report(), { from: f.author });
      assert.equal((await f.market.read.getPublication([f.id])).state, State.Approved);
    });

    it("rejects a duplicate job id, including on another publication", async () => {
      const second = await createSamplePublication(f, BigInt(await networkHelpers.time.latest()));
      const r = report();
      await submit(r);
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(sampleReport(second.id, second.quote, { jobId: r.jobId })),
        f.market,
        "ReportJobIdUsed",
        [r.jobId],
      );
      assert.equal((await f.market.read.getPublication([second.id])).state, State.Deposited);
    });

    it("rejects reports signed by accounts without REPORTER_ROLE", async () => {
      for (const wrong of [f.other, f.quoteSigner, f.reviewer, f.admin, f.author]) {
        await viem.assertions.revertWithCustomError(submit(report(), { signer: wrong }), f.market, "InvalidReportSignature");
      }
    });

    it("rejects a report from a revoked reporter and malformed signatures", async () => {
      const r = report();
      const sig = await signReport(f.reporter, f.chainId, f.market.address, r);
      await f.market.write.revokeRole([roleId("REPORTER_ROLE"), f.reporter.account.address]);
      await viem.assertions.revertWithCustomError(
        f.market.write.submitReviewReport([f.id, r, sig]),
        f.market,
        "InvalidReportSignature",
      );
      for (const bad of ["0x", "0x1234", `0x${"00".repeat(65)}`] as Hex[]) {
        await viem.assertions.revertWithCustomError(
          f.market.write.submitReviewReport([f.id, r, bad]),
          f.market,
          "InvalidReportSignature",
        );
      }
    });

    it("rejects a signed report with any field altered after signing", async () => {
      const r = report();
      const sig = await signReport(f.reporter, f.chainId, f.market.address, r);
      const tampered: Partial<Report>[] = [
        { flagged: true },
        { score: r.score + 1 },
        { aiCost: r.aiCost - 1n },
        { reportHash: randomBytes32() },
        { modelVersion: randomBytes32() },
        { promptVersion: randomBytes32() },
        { jobId: randomBytes32() },
      ];
      for (const t of tampered) {
        await viem.assertions.revertWithCustomError(
          f.market.write.submitReviewReport([f.id, { ...r, ...t }, sig]),
          f.market,
          "InvalidReportSignature",
        );
      }
    });

    it("rejects correctly signed reports with the wrong manifest hash, Arweave ID or policy", async () => {
      await f.market.write.createPolicy([SAMPLE_POLICY]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ manifestHash: keccak256(toHex("other manifest")) })),
        f.market,
        "ReportManifestMismatch",
        [f.id],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ arweaveBundleTxId: OTHER_TX_ID })),
        f.market,
        "ReportArweaveTxIdMismatch",
        [f.id],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ arweaveBundleTxId: f.quote.arweavePreviewTxId })),
        f.market,
        "ReportArweaveTxIdMismatch",
        [f.id],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ policyId: 2n })),
        f.market,
        "ReportPolicyMismatch",
        [f.id, 1n, 2n],
      );
    });

    it("rejects a report whose publicationId differs from the argument", async () => {
      const second = await createSamplePublication(f, BigInt(await networkHelpers.time.latest()));
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report(), { id: second.id }),
        f.market,
        "ReportPublicationMismatch",
        [second.id, f.id],
      );
    });

    it("rejects aiCost above aiCap", async () => {
      const aiCost = f.quote.aiCap + 1n;
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ aiCost })),
        f.market,
        "AiCostExceedsCap",
        [aiCost, f.quote.aiCap],
      );
    });

    it("rejects unknown publications", async () => {
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ publicationId: 99n })),
        f.market,
        "UnknownPublication",
        [99n],
      );
    });

    it("rejects double reporting after approval or flag and never recognizes A twice", async () => {
      const first = report({ aiCost: parseEther("0.003") });
      await submit(first);
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(report({ aiCost: parseEther("0.001") })),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Approved],
      );

      const second = await createSamplePublication(f, BigInt(await networkHelpers.time.latest()));
      await submit(sampleReport(second.id, second.quote, { flagged: true, aiCost: parseEther("0.001") }));
      await viem.assertions.revertWithCustomErrorWithArgs(
        submit(sampleReport(second.id, second.quote, { flagged: false })),
        f.market,
        "InvalidPublicationState",
        [second.id, State.Flagged],
      );

      assert.equal((await credits()).ai, parseEther("0.004"));
      assert.equal((await f.market.read.getPublication([f.id])).aiCost, parseEther("0.003"));
      await assertBooks();
    });
  });

  // ---------------------------------------------------------------- service errors

  describe("service errors", () => {
    it("leave an unreviewed publication Deposited with its full deposit locked and no way to forfeit it", async () => {
      await networkHelpers.time.increase(365n * 24n * 3600n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.finalizeRejection([f.id]),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Deposited],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.claimAppealTimeout([f.id]),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Deposited],
      );
      await viem.assertions.revertWithCustomError(
        f.market.write.resolveAppeal([f.id, false, REASON], { account: f.reviewer.account }),
        f.market,
        "InvalidPublicationState",
      );
      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.state, State.Deposited);
      assert.equal(p.settlementReason, Settlement.None);
      assert.equal(await f.market.read.totalLockedDeposits(), S);
      assert.equal(await f.market.read.totalCredits(), 0n);
    });
  });

  // ---------------------------------------------------------------- appeal

  describe("appeal", () => {
    it("succeeds one second before the deadline and records the resolution deadline", async () => {
      const deadline = await flag();
      await at(deadline - 1n);
      const hash = await f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account });
      const resolution = deadline - 1n + SAMPLE_POLICY.appealResolutionDuration;

      await viem.assertions.emitWithArgs(hash, f.market, "AppealFiled", [f.id, EVIDENCE, resolution]);
      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [f.id, State.Flagged, State.AppealPending]);
      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.state, State.AppealPending);
      assert.equal(p.appealedAt, deadline - 1n);
      assert.equal(p.appealResolutionDeadline, resolution);
      assert.equal(p.settlementReason, Settlement.None);
    });

    it("fails exactly at the deadline", async () => {
      const deadline = await flag();
      await at(deadline);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account }),
        f.market,
        "AppealWindowClosed",
        [f.id, deadline],
      );
    });

    it("is author only", async () => {
      await flag();
      for (const who of [f.other, f.reviewer, f.admin]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          f.market.write.appeal([f.id, EVIDENCE], { account: who.account }),
          f.market,
          "NotAuthor",
          [f.id, getAddress(who.account.address)],
        );
      }
    });

    it("requires the Flagged state and cannot be filed twice", async () => {
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Deposited],
      );
      await flagAndAppeal();
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account }),
        f.market,
        "InvalidPublicationState",
        [f.id, State.AppealPending],
      );
    });

    it("works while paused", async () => {
      await flag();
      await f.market.write.pause({ account: f.pauser.account });
      await f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account });
      assert.equal((await f.market.read.getPublication([f.id])).state, State.AppealPending);
    });
  });

  // ---------------------------------------------------------------- finalizeRejection

  describe("finalizeRejection", () => {
    it("fails one second before the deadline", async () => {
      const deadline = await flag();
      await at(deadline - 1n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.finalizeRejection([f.id]),
        f.market,
        "AppealWindowOpen",
        [f.id, deadline],
      );
    });

    it("lets anyone reject at the deadline, crediting S - A to the owner", async () => {
      const A = parseEther("0.002");
      const deadline = await flag(A);
      await at(deadline);
      const hash = await f.market.write.finalizeRejection([f.id], { account: f.other.account });

      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [f.id, State.Flagged, State.Rejected]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationRejected", [f.id, Settlement.Rejected]);
      await viem.assertions.emitWithArgs(hash, f.market, "Credited", [
        getAddress(f.owner.account.address), f.id, Credit.OwnerAllocation, S - A,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [f.id, Settlement.Rejected, S, A, 0n, S - A, 0n]);

      await assertSettled(Settlement.Rejected, 0n, S - A);
      const c = await credits();
      assert.deepEqual(c, { ai: A, owner: S - A, author: 0n });
      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.settledAt, deadline);
      assert.equal(p.decidedAt, deadline);
    });

    it("requires Flagged: not before a report, not after an appeal", async () => {
      await viem.assertions.revertWithCustomError(f.market.write.finalizeRejection([f.id]), f.market, "InvalidPublicationState");
      const resolution = await flagAndAppeal();
      await at(resolution + 1000n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.finalizeRejection([f.id]),
        f.market,
        "InvalidPublicationState",
        [f.id, State.AppealPending],
      );
    });
  });

  // ---------------------------------------------------------------- resolveAppeal

  describe("resolveAppeal", () => {
    it("approval moves to Approved without settling", async () => {
      const A = parseEther("0.002");
      const resolution = await flagAndAppeal(A);
      await at(resolution - 1n);
      const hash = await f.market.write.resolveAppeal([f.id, true, REASON], { account: f.reviewer.account });

      await viem.assertions.emitWithArgs(hash, f.market, "AppealResolved", [
        f.id, getAddress(f.reviewer.account.address), true, REASON,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "ReviewStatusChanged", [f.id, State.AppealPending, State.Approved]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationApproved", [f.id, Path.Appeal]);

      const p = await f.market.read.getPublication([f.id]);
      assert.equal(p.state, State.Approved);
      assert.equal(p.settlementReason, Settlement.None);
      assert.equal(p.decidedAt, resolution - 1n);
      assert.equal(await f.market.read.totalLockedDeposits(), S - A);
      assert.deepEqual(await credits(), { ai: A, owner: 0n, author: 0n });
      await assertBooks();
    });

    it("rejection moves to Rejected and credits S - A to the owner with reason Rejected", async () => {
      const A = parseEther("0.004");
      await flagAndAppeal(A);
      const hash = await f.market.write.resolveAppeal([f.id, false, REASON], { account: f.reviewer.account });

      await viem.assertions.emitWithArgs(hash, f.market, "AppealResolved", [
        f.id, getAddress(f.reviewer.account.address), false, REASON,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "PublicationRejected", [f.id, Settlement.Rejected]);
      await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [f.id, Settlement.Rejected, S, A, 0n, S - A, 0n]);
      await assertSettled(Settlement.Rejected, 0n, S - A);
      assert.deepEqual(await credits(), { ai: A, owner: S - A, author: 0n });
    });

    it("fails exactly at the resolution deadline", async () => {
      const resolution = await flagAndAppeal();
      await at(resolution);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.resolveAppeal([f.id, true, REASON], { account: f.reviewer.account }),
        f.market,
        "ResolutionWindowClosed",
        [f.id, resolution],
      );
    });

    it("is REVIEWER_ROLE only", async () => {
      await flagAndAppeal();
      for (const who of [f.admin, f.author, f.reporter, f.other]) {
        await viem.assertions.revertWithCustomError(
          f.market.write.resolveAppeal([f.id, true, REASON], { account: who.account }),
          f.market,
          "AccessControlUnauthorizedAccount",
        );
      }
    });

    it("requires AppealPending", async () => {
      await flag();
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.resolveAppeal([f.id, true, REASON], { account: f.reviewer.account }),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Flagged],
      );
    });
  });

  // ---------------------------------------------------------------- claimAppealTimeout

  describe("claimAppealTimeout", () => {
    it("fails one second before the resolution deadline", async () => {
      const resolution = await flagAndAppeal();
      await at(resolution - 1n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.claimAppealTimeout([f.id]),
        f.market,
        "ResolutionWindowOpen",
        [f.id, resolution],
      );
    });

    it("lets anyone claim at the deadline, crediting S - A to the author with reason AppealTimeout", async () => {
      const A = parseEther("0.002");
      const resolution = await flagAndAppeal(A);
      await at(resolution);
      const hash = await f.market.write.claimAppealTimeout([f.id], { account: f.other.account });

      await viem.assertions.emitWithArgs(hash, f.market, "PublicationRejected", [f.id, Settlement.AppealTimeout]);
      await viem.assertions.emitWithArgs(hash, f.market, "Credited", [
        getAddress(f.author.account.address), f.id, Credit.DepositRefund, S - A,
      ]);
      await viem.assertions.emitWithArgs(hash, f.market, "DepositSettled", [
        f.id, Settlement.AppealTimeout, S, A, S - A, 0n, 0n,
      ]);
      await assertSettled(Settlement.AppealTimeout, S - A, 0n);
      assert.deepEqual(await credits(), { ai: A, owner: 0n, author: S - A });
    });

    it("requires AppealPending", async () => {
      await flag();
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.market.write.claimAppealTimeout([f.id]),
        f.market,
        "InvalidPublicationState",
        [f.id, State.Flagged],
      );
    });
  });

  // ---------------------------------------------------------------- double settlement

  describe("no double settlement", () => {
    async function assertNoFurtherSettlement() {
      const before = await credits();
      const locked = await f.market.read.totalLockedDeposits();
      await networkHelpers.time.increase(365n * 24n * 3600n);
      const attempts = [
        f.market.write.finalizeRejection([f.id]),
        f.market.write.claimAppealTimeout([f.id]),
        f.market.write.resolveAppeal([f.id, false, REASON], { account: f.reviewer.account }),
        f.market.write.resolveAppeal([f.id, true, REASON], { account: f.reviewer.account }),
        f.market.write.appeal([f.id, EVIDENCE], { account: f.author.account }),
        submit(report({ flagged: true })),
      ];
      for (const attempt of attempts) {
        await viem.assertions.revertWithCustomErrorWithArgs(attempt, f.market, "InvalidPublicationState", [
          f.id,
          State.Rejected,
        ]);
      }
      assert.deepEqual(await credits(), before);
      assert.equal(await f.market.read.totalLockedDeposits(), locked);
      await assertBooks();
    }

    it("after finalizeRejection", async () => {
      const deadline = await flag();
      await at(deadline);
      await f.market.write.finalizeRejection([f.id]);
      await assertNoFurtherSettlement();
    });

    it("after an upheld appeal", async () => {
      await flagAndAppeal();
      await f.market.write.resolveAppeal([f.id, false, REASON], { account: f.reviewer.account });
      await assertNoFurtherSettlement();
    });

    it("after an appeal timeout", async () => {
      const resolution = await flagAndAppeal();
      await at(resolution);
      await f.market.write.claimAppealTimeout([f.id]);
      await assertNoFurtherSettlement();
    });

    it("a successful appeal never triggers rejection settlement", async () => {
      await flagAndAppeal();
      await f.market.write.resolveAppeal([f.id, true, REASON], { account: f.reviewer.account });
      await networkHelpers.time.increase(365n * 24n * 3600n);
      for (const attempt of [f.market.write.finalizeRejection([f.id]), f.market.write.claimAppealTimeout([f.id])]) {
        await viem.assertions.revertWithCustomErrorWithArgs(attempt, f.market, "InvalidPublicationState", [
          f.id,
          State.Approved,
        ]);
      }
      assert.equal((await f.market.read.getPublication([f.id])).settlementReason, Settlement.None);
    });

    it("settles several publications independently and keeps the books balanced", async () => {
      const now = BigInt(await networkHelpers.time.latest());
      const b = await createSamplePublication(f, now, { deposit: parseEther("0.08"), aiCap: parseEther("0.01") });
      const c = await createSamplePublication(f, now);

      await submit(report({ flagged: true, aiCost: parseEther("0.001") }));
      await submit(sampleReport(b.id, b.quote, { flagged: true, aiCost: parseEther("0.01") }));
      await submit(sampleReport(c.id, c.quote, { flagged: false, aiCost: 0n }));
      await f.market.write.appeal([b.id, EVIDENCE], { account: f.author.account });

      const pa = await f.market.read.getPublication([f.id]);
      const pb = await f.market.read.getPublication([b.id]);
      await at(pb.appealResolutionDeadline > pa.appealDeadline ? pb.appealResolutionDeadline : pa.appealDeadline);
      await f.market.write.finalizeRejection([f.id]);
      await f.market.write.claimAppealTimeout([b.id]);

      assert.deepEqual(await credits(), {
        ai: parseEther("0.011"),
        owner: S - parseEther("0.001"),
        author: parseEther("0.08") - parseEther("0.01"),
      });
      // Only the approved publication c remains locked.
      assert.equal(await f.market.read.totalLockedDeposits(), c.quote.deposit);
      await assertBooks();
    });
  });
});
