import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, parseEther, toHex, type Hex } from "viem";

import {
  Action,
  OTHER_TX_ID,
  SAMPLE_POLICY,
  ZERO_BYTES32,
  deployMarket,
  randomNonce,
  roleId,
  sampleCertificate,
  sampleQuote,
  signCertificate,
  signQuote,
  type Certificate,
  type PolicyInput,
  type Quote,
} from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

async function marketFixture() {
  return deployMarket(viem);
}

type Fixture = Awaited<ReturnType<typeof marketFixture>>;

describe("ConsentCraftMarket: policies, roles and publication creation", () => {
  let f: Fixture;
  let now: bigint;

  beforeEach(async () => {
    f = await networkHelpers.loadFixture(marketFixture);
    now = BigInt(await networkHelpers.time.latest());
  });

  /** Signs quote and certificate with the given (default: authorized) signers. */
  async function signed(
    quote: Quote,
    cert: Certificate,
    opts: { quoteSigner?: Fixture["quoteSigner"]; certSigner?: Fixture["quoteSigner"]; market?: Hex } = {},
  ) {
    const market = opts.market ?? f.market.address;
    const quoteSig = await signQuote(opts.quoteSigner ?? f.quoteSigner, f.chainId, market, quote);
    const certSig = await signCertificate(opts.certSigner ?? f.quoteSigner, f.chainId, market, cert);
    return { quoteSig, certSig };
  }

  function create(quote: Quote, quoteSig: Hex, cert: Certificate, certSig: Hex, value = quote.deposit, from = f.author) {
    return f.market.write.createPublication([quote, quoteSig, cert, certSig], { account: from.account, value });
  }

  async function validArgs(quoteOverrides: Partial<Quote> = {}, certOverrides: Partial<Certificate> = {}) {
    const quote = sampleQuote(f.author.account.address, now, quoteOverrides);
    const cert = sampleCertificate(f.author.account.address, now, certOverrides);
    const { quoteSig, certSig } = await signed(quote, cert);
    return { quote, cert, quoteSig, certSig };
  }

  // -----------------------------------------------------------------------
  describe("deployment and roles", () => {
    it("sets recipients and grants only DEFAULT_ADMIN_ROLE to the admin", async () => {
      const { market, admin, owner, aiRecipient } = f;
      assert.equal(await market.read.ownerRecipient(), getAddress(owner.account.address));
      assert.equal(await market.read.aiExpenseRecipient(), getAddress(aiRecipient.account.address));
      assert.equal(await market.read.hasRole([ZERO_BYTES32, admin.account.address]), true);
      for (const role of ["QUOTE_SIGNER_ROLE", "REPORTER_ROLE", "REVIEWER_ROLE", "PAUSER_ROLE"]) {
        assert.equal(await market.read[role as "PAUSER_ROLE"](), roleId(role));
      }
      assert.equal(await market.read.hasRole([roleId("PAUSER_ROLE"), admin.account.address]), false);
    });

    it("rejects zero addresses in the constructor", async () => {
      const a = f.admin.account.address;
      for (const args of [
        [ZERO_BYTES32.slice(0, 42), a, a],
        [a, ZERO_BYTES32.slice(0, 42), a],
        [a, a, ZERO_BYTES32.slice(0, 42)],
      ] as const) {
        await assert.rejects(viem.deployContract("ConsentCraftMarket", args as unknown as [Hex, Hex, Hex]), /ZeroAddress/);
      }
    });

    it("lets only the admin change recipients, emits events, and rejects zero", async () => {
      const { market, other, owner } = f;
      await viem.assertions.emitWithArgs(
        market.write.setOwnerRecipient([other.account.address]),
        market,
        "OwnerRecipientUpdated",
        [getAddress(owner.account.address), getAddress(other.account.address)],
      );
      await viem.assertions.emit(market.write.setAiExpenseRecipient([other.account.address]), market, "AiExpenseRecipientUpdated");
      await viem.assertions.revertWithCustomError(
        market.write.setOwnerRecipient([ZERO_BYTES32.slice(0, 42) as Hex]),
        market,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        market.write.setOwnerRecipient([other.account.address], { account: other.account }),
        market,
        "AccessControlUnauthorizedAccount",
      );
      await viem.assertions.revertWithCustomError(
        market.write.setAiExpenseRecipient([other.account.address], { account: other.account }),
        market,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("exposes no state-changing function beyond the documented set (no sweep, no policy edits)", () => {
      const mutating = f.market.abi
        .filter((x) => x.type === "function" && (x.stateMutability === "nonpayable" || x.stateMutability === "payable"))
        .map((x) => (x as { name: string }).name)
        .sort();
      assert.deepEqual(mutating, [
        "createPolicy",
        "createPublication",
        "grantRole",
        "pause",
        "renounceRole",
        "revokeRole",
        "setAiExpenseRecipient",
        "setOwnerRecipient",
        "unpause",
      ]);
    });

    it("uses the EIP-712 type strings documented in the spec", async () => {
      assert.equal(
        await f.market.read.PUBLICATION_QUOTE_TYPEHASH(),
        keccak256(
          toHex(
            "PublicationQuote(address author,bytes32 manifestHash,bytes32 previewManifestHash,bytes32 arweaveBundleTxId,bytes32 arweavePreviewTxId,uint32 pageCount,uint256 policyId,uint256 price,uint256 deposit,uint256 aiCap,uint8 ratingSnapshot,uint64 expiresAt,uint256 nonce)",
          ),
        ),
      );
      assert.equal(
        await f.market.read.PERSONHOOD_CERTIFICATE_TYPEHASH(),
        keccak256(toHex("PersonhoodCertificate(address wallet,uint8 action,uint64 expiresAt,uint256 nonce)")),
      );
      const [, name, version, chainId, verifyingContract] = await f.market.read.eip712Domain();
      assert.equal(name, "ConsentCraftMarket");
      assert.equal(version, "1");
      assert.equal(chainId, BigInt(f.chainId));
      assert.equal(verifyingContract, getAddress(f.market.address));
    });
  });

  // -----------------------------------------------------------------------
  describe("policies", () => {
    it("appends policies with sequential ids and stores every field", async () => {
      const { market } = f;
      assert.equal(await market.read.policyCount(), 1n);
      const second: PolicyInput = { ...SAMPLE_POLICY, feeBps: 0, minFee: 0n, minPrice: 1n, maxPrice: 1n, purchaseRequiresPersonhood: false };
      await viem.assertions.emitWithArgs(market.write.createPolicy([second]), market, "PolicyCreated", [
        2n,
        second.minFee,
        second.feeBps,
        second.minPrice,
        second.maxPrice,
        second.appealDuration,
        second.appealResolutionDuration,
        second.refundDelay,
        second.purchaseRequiresPersonhood,
      ]);
      assert.equal(await market.read.policyCount(), 2n);
      assert.deepEqual(await market.read.getPolicy([1n]), SAMPLE_POLICY);
      assert.deepEqual(await market.read.getPolicy([2n]), second);
    });

    it("accepts feeBps = 10000 and minPrice = minFee + 1", async () => {
      await f.market.write.createPolicy([{ ...SAMPLE_POLICY, feeBps: 10_000, minFee: 5n, minPrice: 6n, maxPrice: 6n }]);
      assert.equal(await f.market.read.policyCount(), 2n);
    });

    it("rejects invalid policy values", async () => {
      const bad: Partial<PolicyInput>[] = [
        { feeBps: 10_001 },
        { minFee: 10n, minPrice: 10n }, // minPrice must be > minFee
        { minFee: 10n, minPrice: 9n },
        { minPrice: 100n, maxPrice: 99n },
        { appealDuration: 0n },
        { appealResolutionDuration: 0n },
        { refundDelay: 0n },
      ];
      for (const override of bad) {
        await viem.assertions.revertWithCustomError(
          f.market.write.createPolicy([{ ...SAMPLE_POLICY, ...override }]),
          f.market,
          "InvalidPolicy",
        );
      }
      assert.equal(await f.market.read.policyCount(), 1n);
    });

    it("allows only DEFAULT_ADMIN_ROLE to create policies", async () => {
      for (const who of [f.other, f.quoteSigner, f.pauser]) {
        await viem.assertions.revertWithCustomError(
          f.market.write.createPolicy([SAMPLE_POLICY], { account: who.account }),
          f.market,
          "AccessControlUnauthorizedAccount",
        );
      }
    });

    it("reverts for unknown policy ids", async () => {
      for (const id of [0n, 2n]) {
        await viem.assertions.revertWithCustomErrorWithArgs(f.market.read.getPolicy([id]), f.market, "UnknownPolicy", [id]);
      }
    });
  });

  // -----------------------------------------------------------------------
  describe("createPublication: valid", () => {
    it("stores the frozen terms, locks the deposit and emits PublicationCreated", async () => {
      const { market, publicClient, author } = f;
      const { quote, cert, quoteSig, certSig } = await validArgs();

      const hash = await create(quote, quoteSig, cert, certSig);
      await viem.assertions.emitWithArgs(hash, market, "PublicationCreated", [
        1n,
        getAddress(author.account.address),
        quote.policyId,
        quote.manifestHash,
        quote.previewManifestHash,
        quote.arweaveBundleTxId,
        quote.arweavePreviewTxId,
        quote.pageCount,
        quote.price,
        quote.deposit,
        quote.aiCap,
      ]);
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

      const p = await market.read.getPublication([1n]);
      assert.equal(p.author, getAddress(author.account.address));
      assert.equal(p.policyId, quote.policyId);
      assert.equal(p.manifestHash, quote.manifestHash);
      assert.equal(p.previewManifestHash, quote.previewManifestHash);
      assert.equal(p.arweaveBundleTxId, quote.arweaveBundleTxId);
      assert.equal(p.arweavePreviewTxId, quote.arweavePreviewTxId);
      assert.equal(p.pageCount, quote.pageCount);
      assert.equal(p.ratingSnapshot, quote.ratingSnapshot);
      assert.equal(p.price, quote.price);
      assert.equal(p.deposit, quote.deposit);
      assert.equal(p.aiCap, quote.aiCap);
      assert.equal(p.aiCost, 0n);
      assert.equal(p.grossSales, 0n);
      assert.equal(p.state, 0); // Deposited
      assert.equal(p.listingState, 0); // Unlisted
      assert.equal(p.settlementReason, 0); // None
      assert.equal(p.createdAt, block.timestamp);
      for (const t of [p.reviewedAt, p.appealDeadline, p.publishedAt, p.settledAt, p.delistedAt]) assert.equal(t, 0n);

      assert.equal(await market.read.publicationCount(), 1n);
      assert.equal(await market.read.isQuoteNonceUsed([quote.nonce]), true);
      assert.equal(await market.read.isCertificateNonceUsed([cert.nonce]), true);
      assert.equal(await market.read.totalLockedDeposits(), quote.deposit);
      assert.equal(await market.read.totalCredits(), 0n);
      assert.equal(await market.read.totalLiabilities(), quote.deposit);
      assert.equal(await publicClient.getBalance({ address: market.address }), quote.deposit);
      assert.equal(await market.read.liabilitiesCovered(), true);
    });

    it("tracks the sum of locked deposits across publications", async () => {
      const a = await validArgs({ deposit: parseEther("0.05") });
      await create(a.quote, a.quoteSig, a.cert, a.certSig);
      const b = await validArgs({ deposit: parseEther("0.07"), aiCap: parseEther("0.069") });
      await create(b.quote, b.quoteSig, b.cert, b.certSig);
      assert.equal(await f.market.read.publicationCount(), 2n);
      assert.equal(await f.market.read.totalLockedDeposits(), parseEther("0.12"));
      assert.equal(await f.publicClient.getBalance({ address: f.market.address }), parseEther("0.12"));
      assert.equal(await f.market.read.liabilitiesCovered(), true);
    });

    it("accepts price exactly at minPrice and maxPrice and deposit = aiCap + 1", async () => {
      for (const overrides of [
        { price: SAMPLE_POLICY.minPrice },
        { price: SAMPLE_POLICY.maxPrice },
        { aiCap: parseEther("0.05") - 1n },
      ]) {
        const a = await validArgs(overrides);
        await create(a.quote, a.quoteSig, a.cert, a.certSig);
      }
      assert.equal(await f.market.read.publicationCount(), 3n);
    });

    it("accepts a quote and certificate in the block at exactly expiresAt", async () => {
      const a = await validArgs({ expiresAt: now + 100n }, { expiresAt: now + 100n });
      await networkHelpers.time.setNextBlockTimestamp(now + 100n);
      await create(a.quote, a.quoteSig, a.cert, a.certSig);
      assert.equal(await f.market.read.publicationCount(), 1n);
    });
  });

  // -----------------------------------------------------------------------
  describe("createPublication: quote integrity", () => {
    const tampering: [string, (q: Quote) => Partial<Quote>][] = [
      ["arweaveBundleTxId", () => ({ arweaveBundleTxId: OTHER_TX_ID })],
      ["arweavePreviewTxId", () => ({ arweavePreviewTxId: OTHER_TX_ID })],
      ["swapped Arweave IDs", (q) => ({ arweaveBundleTxId: q.arweavePreviewTxId, arweavePreviewTxId: q.arweaveBundleTxId })],
      ["manifestHash", () => ({ manifestHash: keccak256(toHex("tampered")) })],
      ["previewManifestHash", () => ({ previewManifestHash: keccak256(toHex("tampered")) })],
      ["pageCount", (q) => ({ pageCount: q.pageCount + 1 })],
      ["policyId", () => ({ policyId: 2n })],
      ["price", (q) => ({ price: q.price + 1n })],
      ["deposit", (q) => ({ deposit: q.deposit + 1n })],
      ["aiCap", (q) => ({ aiCap: q.aiCap - 1n })],
      ["ratingSnapshot", (q) => ({ ratingSnapshot: q.ratingSnapshot + 1 })],
      ["expiresAt", (q) => ({ expiresAt: q.expiresAt + 1n })],
      ["nonce", (q) => ({ nonce: q.nonce + 1n })],
    ];

    for (const [field, tamper] of tampering) {
      it(`rejects a signed quote with altered ${field}`, async () => {
        await f.market.write.createPolicy([SAMPLE_POLICY]); // so policyId 2 exists
        const a = await validArgs();
        const altered = { ...a.quote, ...tamper(a.quote) };
        await viem.assertions.revertWithCustomError(
          create(altered, a.quoteSig, a.cert, a.certSig, altered.deposit),
          f.market,
          "InvalidQuoteSignature",
        );
        assert.equal(await f.market.read.publicationCount(), 0n);
      });
    }

    it("rejects a quote whose author is not the caller", async () => {
      const a = await validArgs();
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, { ...a.cert, wallet: f.other.account.address }, a.certSig, a.quote.deposit, f.other),
        f.market,
        "QuoteAuthorMismatch",
        [getAddress(f.author.account.address), getAddress(f.other.account.address)],
      );
    });

    it("rejects a quote re-addressed to another author", async () => {
      const a = await validArgs();
      const quote = { ...a.quote, author: f.other.account.address };
      const cert = sampleCertificate(f.other.account.address, now);
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await viem.assertions.revertWithCustomError(
        create(quote, a.quoteSig, cert, certSig, quote.deposit, f.other),
        f.market,
        "InvalidQuoteSignature",
      );
    });

    it("rejects signed quotes with zero Arweave IDs, zero hashes or zero pages", async () => {
      const cases: [Partial<Quote>, string][] = [
        [{ arweaveBundleTxId: ZERO_BYTES32 }, "ZeroArweaveTxId"],
        [{ arweavePreviewTxId: ZERO_BYTES32 }, "ZeroArweaveTxId"],
        [{ manifestHash: ZERO_BYTES32 }, "ZeroManifestHash"],
        [{ previewManifestHash: ZERO_BYTES32 }, "ZeroManifestHash"],
        [{ pageCount: 0 }, "ZeroPageCount"],
      ];
      for (const [overrides, error] of cases) {
        const a = await validArgs(overrides);
        await viem.assertions.revertWithCustomError(
          create(a.quote, a.quoteSig, a.cert, a.certSig),
          f.market,
          error as "ZeroArweaveTxId",
        );
      }
    });

    it("rejects an expired quote", async () => {
      const a = await validArgs({ expiresAt: now + 10n }, { expiresAt: now + 1000n });
      await networkHelpers.time.setNextBlockTimestamp(now + 11n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, a.cert, a.certSig),
        f.market,
        "QuoteExpired",
        [now + 10n],
      );
    });

    it("rejects quote replay, including a re-signed quote reusing the nonce", async () => {
      const a = await validArgs();
      await create(a.quote, a.quoteSig, a.cert, a.certSig);

      const cert2 = sampleCertificate(f.author.account.address, now);
      const certSig2 = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert2);
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, cert2, certSig2),
        f.market,
        "QuoteNonceUsed",
        [a.quote.nonce],
      );

      const resigned = { ...a.quote, price: a.quote.price + 1n };
      const resignedSig = await signQuote(f.quoteSigner, f.chainId, f.market.address, resigned);
      await viem.assertions.revertWithCustomError(
        create(resigned, resignedSig, cert2, certSig2),
        f.market,
        "QuoteNonceUsed",
      );
      assert.equal(await f.market.read.publicationCount(), 1n);
    });
  });

  // -----------------------------------------------------------------------
  describe("createPublication: signers", () => {
    it("rejects a quote signed by an account without QUOTE_SIGNER_ROLE", async () => {
      for (const wrong of [f.other, f.author, f.admin, f.reporter]) {
        const quote = sampleQuote(f.author.account.address, now);
        const cert = sampleCertificate(f.author.account.address, now);
        const { quoteSig, certSig } = await signed(quote, cert, { quoteSigner: wrong });
        await viem.assertions.revertWithCustomError(
          create(quote, quoteSig, cert, certSig),
          f.market,
          "InvalidQuoteSignature",
        );
      }
    });

    it("rejects a certificate signed by an account without QUOTE_SIGNER_ROLE", async () => {
      for (const wrong of [f.other, f.author, f.reporter]) {
        const quote = sampleQuote(f.author.account.address, now);
        const cert = sampleCertificate(f.author.account.address, now);
        const { quoteSig, certSig } = await signed(quote, cert, { certSigner: wrong });
        await viem.assertions.revertWithCustomError(
          create(quote, quoteSig, cert, certSig),
          f.market,
          "InvalidCertificateSignature",
        );
      }
    });

    it("rejects signatures from a signer whose role was revoked", async () => {
      const a = await validArgs();
      await f.market.write.revokeRole([roleId("QUOTE_SIGNER_ROLE"), f.quoteSigner.account.address]);
      await viem.assertions.revertWithCustomError(
        create(a.quote, a.quoteSig, a.cert, a.certSig),
        f.market,
        "InvalidQuoteSignature",
      );
    });

    it("rejects malformed signatures without bubbling ECDSA errors", async () => {
      const a = await validArgs();
      for (const sig of ["0x", "0x1234", `0x${"00".repeat(65)}`] as Hex[]) {
        await viem.assertions.revertWithCustomError(create(a.quote, sig, a.cert, a.certSig), f.market, "InvalidQuoteSignature");
        await viem.assertions.revertWithCustomError(create(a.quote, a.quoteSig, a.cert, sig), f.market, "InvalidCertificateSignature");
      }
    });

    it("rejects signatures made for another deployment (domain binds the contract address)", async () => {
      const otherMarket = await viem.deployContract("ConsentCraftMarket", [
        f.admin.account.address,
        f.owner.account.address,
        f.aiRecipient.account.address,
      ]);
      const quote = sampleQuote(f.author.account.address, now);
      const cert = sampleCertificate(f.author.account.address, now);
      const foreign = await signed(quote, cert, { market: otherMarket.address });
      const local = await signed(quote, cert);
      await viem.assertions.revertWithCustomError(
        create(quote, foreign.quoteSig, cert, local.certSig),
        f.market,
        "InvalidQuoteSignature",
      );
      await viem.assertions.revertWithCustomError(
        create(quote, local.quoteSig, cert, foreign.certSig),
        f.market,
        "InvalidCertificateSignature",
      );
    });

    it("rejects signatures made for another chain id", async () => {
      const quote = sampleQuote(f.author.account.address, now);
      const cert = sampleCertificate(f.author.account.address, now);
      const foreignQuoteSig = await signQuote(f.quoteSigner, 11155111, f.market.address, quote);
      const certSig = await signCertificate(f.quoteSigner, f.chainId, f.market.address, cert);
      await viem.assertions.revertWithCustomError(
        create(quote, foreignQuoteSig, cert, certSig),
        f.market,
        "InvalidQuoteSignature",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("createPublication: personhood certificate", () => {
    it("rejects a certificate for another wallet", async () => {
      const a = await validArgs({}, { wallet: f.other.account.address });
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, a.cert, a.certSig),
        f.market,
        "CertificateWalletMismatch",
        [getAddress(f.other.account.address), getAddress(f.author.account.address)],
      );
    });

    it("rejects a PURCHASE certificate for publishing", async () => {
      const a = await validArgs({}, { action: Action.Purchase });
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, a.cert, a.certSig),
        f.market,
        "CertificateActionMismatch",
        [Action.Publish, Action.Purchase],
      );
    });

    it("rejects an expired certificate", async () => {
      const a = await validArgs({ expiresAt: now + 1000n }, { expiresAt: now + 10n });
      await networkHelpers.time.setNextBlockTimestamp(now + 11n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(a.quote, a.quoteSig, a.cert, a.certSig),
        f.market,
        "CertificateExpired",
        [now + 10n],
      );
    });

    it("rejects certificate replay with a fresh quote", async () => {
      const a = await validArgs();
      await create(a.quote, a.quoteSig, a.cert, a.certSig);
      const quote2 = sampleQuote(f.author.account.address, now);
      const quoteSig2 = await signQuote(f.quoteSigner, f.chainId, f.market.address, quote2);
      await viem.assertions.revertWithCustomErrorWithArgs(
        create(quote2, quoteSig2, a.cert, a.certSig),
        f.market,
        "CertificateNonceUsed",
        [a.cert.nonce],
      );
    });

    it("rejects a certificate with any signed field altered", async () => {
      const a = await validArgs();
      for (const altered of [
        { ...a.cert, expiresAt: a.cert.expiresAt + 1n },
        { ...a.cert, nonce: randomNonce() },
      ]) {
        await viem.assertions.revertWithCustomError(
          create(a.quote, a.quoteSig, altered, a.certSig),
          f.market,
          "InvalidCertificateSignature",
        );
      }
    });

    it("does not consume nonces when creation reverts", async () => {
      const a = await validArgs();
      await viem.assertions.revertWithCustomError(
        create(a.quote, a.quoteSig, a.cert, a.certSig, a.quote.deposit - 1n),
        f.market,
        "DepositMismatch",
      );
      assert.equal(await f.market.read.isQuoteNonceUsed([a.quote.nonce]), false);
      assert.equal(await f.market.read.isCertificateNonceUsed([a.cert.nonce]), false);
      await create(a.quote, a.quoteSig, a.cert, a.certSig);
    });
  });

  // -----------------------------------------------------------------------
  describe("createPublication: terms", () => {
    it("rejects msg.value different from the deposit", async () => {
      const a = await validArgs();
      for (const value of [0n, a.quote.deposit - 1n, a.quote.deposit + 1n]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          create(a.quote, a.quoteSig, a.cert, a.certSig, value),
          f.market,
          "DepositMismatch",
          [a.quote.deposit, value],
        );
      }
    });

    it("rejects S <= aiCap", async () => {
      for (const aiCap of [parseEther("0.05"), parseEther("0.06")]) {
        const a = await validArgs({ deposit: parseEther("0.05"), aiCap });
        await viem.assertions.revertWithCustomErrorWithArgs(
          create(a.quote, a.quoteSig, a.cert, a.certSig),
          f.market,
          "InvalidDepositTerms",
          [parseEther("0.05"), aiCap],
        );
      }
    });

    it("rejects a price outside the policy bounds", async () => {
      for (const price of [0n, SAMPLE_POLICY.minPrice - 1n, SAMPLE_POLICY.maxPrice + 1n]) {
        const a = await validArgs({ price });
        await viem.assertions.revertWithCustomErrorWithArgs(
          create(a.quote, a.quoteSig, a.cert, a.certSig),
          f.market,
          "PriceOutOfBounds",
          [price, SAMPLE_POLICY.minPrice, SAMPLE_POLICY.maxPrice],
        );
      }
    });

    it("rejects a signed quote that references an unknown policy", async () => {
      for (const policyId of [0n, 2n]) {
        const a = await validArgs({ policyId });
        await viem.assertions.revertWithCustomErrorWithArgs(
          create(a.quote, a.quoteSig, a.cert, a.certSig),
          f.market,
          "UnknownPolicy",
          [policyId],
        );
      }
    });

    it("reverts getPublication for unknown ids", async () => {
      await viem.assertions.revertWithCustomErrorWithArgs(f.market.read.getPublication([1n]), f.market, "UnknownPublication", [1n]);
    });
  });

  // -----------------------------------------------------------------------
  describe("pausing", () => {
    it("lets only PAUSER_ROLE pause and unpause", async () => {
      for (const who of [f.admin, f.other]) {
        await viem.assertions.revertWithCustomError(
          f.market.write.pause({ account: who.account }),
          f.market,
          "AccessControlUnauthorizedAccount",
        );
      }
      await f.market.write.pause({ account: f.pauser.account });
      await viem.assertions.revertWithCustomError(
        f.market.write.unpause({ account: f.admin.account }),
        f.market,
        "AccessControlUnauthorizedAccount",
      );
      await f.market.write.unpause({ account: f.pauser.account });
      assert.equal(await f.market.read.paused(), false);
    });

    it("blocks new deposits while paused and allows them after unpausing", async () => {
      const a = await validArgs();
      await viem.assertions.emit(f.market.write.pause({ account: f.pauser.account }), f.market, "Paused");
      await viem.assertions.revertWithCustomError(create(a.quote, a.quoteSig, a.cert, a.certSig), f.market, "EnforcedPause");
      await f.market.write.unpause({ account: f.pauser.account });
      await create(a.quote, a.quoteSig, a.cert, a.certSig);
      assert.equal(await f.market.read.publicationCount(), 1n);
    });

    it("does not block administration while paused", async () => {
      await f.market.write.pause({ account: f.pauser.account });
      await f.market.write.createPolicy([SAMPLE_POLICY]);
      await f.market.write.setOwnerRecipient([f.other.account.address]);
      await f.market.write.grantRole([roleId("REVIEWER_ROLE"), f.other.account.address]);
      assert.equal(await f.market.read.policyCount(), 2n);
    });
  });

  // -----------------------------------------------------------------------
  describe("direct ETH and unknown calls", () => {
    it("rejects plain ETH transfers and unknown calldata", async () => {
      const { market, other, publicClient } = f;
      const rejected = /custom error 'DirectPaymentRejected\(\)'/;
      await assert.rejects(other.sendTransaction({ to: market.address, value: 1n }), rejected);
      await assert.rejects(other.sendTransaction({ to: market.address, value: 1n, data: "0xdeadbeef" }), rejected);
      await assert.rejects(other.sendTransaction({ to: market.address, data: "0xdeadbeef" }), rejected);
      assert.equal(await publicClient.getBalance({ address: market.address }), 0n);
    });
  });
});
