import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { type Hex } from "viem";

import {
  Action,
  SAMPLE_POLICY,
  State,
  createApprovedPublication,
  createSamplePublication,
  deployMarket,
  sampleCertificate,
  sampleQuote,
  sampleReport,
  signCertificate,
  signQuote,
  signReport,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

const UINT32_MAX = 2n ** 32n - 1n;

async function auditFixture() {
  return deployMarket(viem);
}

type Fixture = Awaited<ReturnType<typeof auditFixture>>;

describe("ConsentCraftMarket: audit regressions and replay matrix", () => {
  let f: Fixture;
  let now: bigint;

  beforeEach(async () => {
    f = await networkHelpers.loadFixture(auditFixture);
    now = BigInt(await networkHelpers.time.latest());
  });

  // -----------------------------------------------------------------------
  // L-01: unbounded policy durations could overflow uint64 deadlines and
  // permanently brick publish / flagging / appeals for every publication on
  // that policy, locking deposits.
  describe("L-01 policy duration bounds", () => {
    it("rejects durations that could overflow uint64 deadlines", async () => {
      for (const field of ["appealDuration", "appealResolutionDuration", "refundDelay"] as const) {
        for (const value of [UINT32_MAX + 1n, 2n ** 64n - 1n]) {
          await viem.assertions.revertWithCustomError(
            f.market.write.createPolicy([{ ...SAMPLE_POLICY, [field]: value }]),
            f.market,
            "InvalidPolicy",
          );
        }
      }
    });

    it("accepts the maximum durations, and flag, appeal and publish still work under them", async () => {
      await f.market.write.createPolicy([
        { ...SAMPLE_POLICY, appealDuration: UINT32_MAX, appealResolutionDuration: UINT32_MAX, refundDelay: UINT32_MAX },
      ]);
      // Flag and appeal on policy 2.
      const flagged = await createSamplePublication(f, now, { policyId: 2n });
      const r = sampleReport(flagged.id, flagged.quote, { flagged: true });
      await f.market.write.submitReviewReport([flagged.id, r, await signReport(f.reporter, f.chainId, f.market.address, r)]);
      await f.market.write.appeal([flagged.id, r.reportHash], { account: f.author.account });
      const p = await f.market.read.getPublication([flagged.id]);
      assert.equal(p.state, State.AppealPending);
      assert.equal(p.appealResolutionDeadline - p.appealedAt, UINT32_MAX);

      // Publish on policy 2.
      const approved = await createApprovedPublication(f, now, { policyId: 2n });
      await f.market.write.publish([approved.id], { account: f.author.account });
      const q = await f.market.read.getPublication([approved.id]);
      assert.equal(q.refundEligibleAt - q.publishedAt, UINT32_MAX);
    });
  });

  // -----------------------------------------------------------------------
  describe("signature replay matrix", () => {
    it("a report signed for one publication cannot be used for another", async () => {
      const a = await createSamplePublication(f, now);
      const b = await createSamplePublication(f, now);
      const r = sampleReport(a.id, a.quote);
      const sig = await signReport(f.reporter, f.chainId, f.market.address, r);
      // Re-pointed at b (same manifest and Arweave ID, as in the fixture): signature no longer matches.
      await viem.assertions.revertWithCustomError(
        f.market.write.submitReviewReport([b.id, { ...r, publicationId: b.id }, sig]),
        f.market,
        "InvalidReportSignature",
      );
      // Used as-is with b's id: publication mismatch.
      await viem.assertions.revertWithCustomError(
        f.market.write.submitReviewReport([b.id, r, sig]),
        f.market,
        "ReportPublicationMismatch",
      );
    });

    it("a report signed for another deployment or chain is rejected", async () => {
      const pub = await createSamplePublication(f, now);
      const r = sampleReport(pub.id, pub.quote);
      const otherMarket = await viem.deployContract("ConsentCraftMarket", [
        f.admin.account.address,
        f.owner.account.address,
        f.aiRecipient.account.address,
      ]);
      for (const sig of [
        await signReport(f.reporter, f.chainId, otherMarket.address, r),
        await signReport(f.reporter, 11155111, f.market.address, r),
      ]) {
        await viem.assertions.revertWithCustomError(
          f.market.write.submitReviewReport([pub.id, r, sig]),
          f.market,
          "InvalidReportSignature",
        );
      }
    });

    it("a used report cannot be replayed on the same deployment after being accepted", async () => {
      const pub = await createSamplePublication(f, now);
      const r = sampleReport(pub.id, pub.quote, { flagged: true });
      const sig = await signReport(f.reporter, f.chainId, f.market.address, r);
      await f.market.write.submitReviewReport([pub.id, r, sig]);
      await viem.assertions.revertWithCustomError(
        f.market.write.submitReviewReport([pub.id, r, sig]),
        f.market,
        "InvalidPublicationState",
      );
    });

    it("signatures do not transfer across types even when one key holds every signing role", async () => {
      // One key holds QUOTE_SIGNER_ROLE and REPORTER_ROLE.
      await f.market.write.grantRole([await f.market.read.REPORTER_ROLE(), f.quoteSigner.account.address]);
      const quote = sampleQuote(f.author.account.address, now);
      const cert = sampleCertificate(f.author.account.address, now);
      const quoteSig = await signQuote(f.quoteSigner, f.chainId, f.market.address, quote);
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);

      // Quote signature presented as the certificate signature, and vice versa.
      await viem.assertions.revertWithCustomError(
        f.market.write.createPublication([quote, quoteSig, cert, quoteSig], { account: f.author.account, value: quote.deposit }),
        f.market,
        "InvalidCertificateSignature",
      );
      await viem.assertions.revertWithCustomError(
        f.market.write.createPublication([quote, certSig, cert, certSig], { account: f.author.account, value: quote.deposit }),
        f.market,
        "InvalidQuoteSignature",
      );

      // A quote signature presented as a report signature.
      await f.market.write.createPublication([quote, quoteSig, cert, certSig], { account: f.author.account, value: quote.deposit });
      const r = sampleReport(1n, quote);
      await viem.assertions.revertWithCustomError(
        f.market.write.submitReviewReport([1n, r, quoteSig as Hex]),
        f.market,
        "InvalidReportSignature",
      );
    });

    it("a PUBLISH certificate cannot buy and a PURCHASE certificate cannot publish", async () => {
      const purchaseCert = sampleCertificate(f.author.account.address, now, { action: Action.Purchase });
      const quote = sampleQuote(f.author.account.address, now);
      await viem.assertions.revertWithCustomError(
        f.market.write.createPublication(
          [
            quote,
            await signQuote(f.quoteSigner, f.chainId, f.market.address, quote),
            purchaseCert,
            await signCertificate(f.quoteSigner, f.chainId, f.market.address, purchaseCert),
          ],
          { account: f.author.account, value: quote.deposit },
        ),
        f.market,
        "CertificateActionMismatch",
      );
      // The PUBLISH-for-purchase direction is covered in the purchase suite.
    });

    it("a certificate consumed in one deployment is still bound to that deployment only", async () => {
      const otherMarket = await viem.deployContract("ConsentCraftMarket", [
        f.admin.account.address,
        f.owner.account.address,
        f.aiRecipient.account.address,
      ]);
      const cert = sampleCertificate(f.author.account.address, now);
      const sigForOther = await signCertificate(f.quoteSigner, f.chainId, otherMarket.address, cert);
      const quote = sampleQuote(f.author.account.address, now);
      await viem.assertions.revertWithCustomError(
        f.market.write.createPublication(
          [quote, await signQuote(f.quoteSigner, f.chainId, f.market.address, quote), cert, sigForOther],
          { account: f.author.account, value: quote.deposit },
        ),
        f.market,
        "InvalidCertificateSignature",
      );
    });
  });
});
