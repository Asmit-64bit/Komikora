import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { privateKeyToAccount } from "viem/accounts";

import { consentCraftMarketAbi } from "../abi/ConsentCraftMarket.js";
import {
  PersonhoodAction,
  randomBytes32,
  randomNonce,
  signPersonhoodCertificate,
  signPublicationQuote,
  signReviewReport,
} from "../lib/eip712.js";
import { deployMarket, sampleQuote, sampleReport } from "../test-support/market.js";

const { viem, networkHelpers } = await network.create();

describe("deployment artifacts", () => {
  it("the committed ABI matches the compiled contract (run `npm run contracts:abi` if this fails)", () => {
    const artifact = JSON.parse(
      readFileSync("artifacts/contracts/ConsentCraftMarket.sol/ConsentCraftMarket.json", "utf8"),
    ) as { abi: unknown[] };
    const committed = JSON.parse(readFileSync("abi/ConsentCraftMarket.json", "utf8"));
    assert.deepEqual(committed, artifact.abi);
    assert.deepEqual(consentCraftMarketAbi, artifact.abi);
  });

  it("the example deployment file matches the documented format", () => {
    const example = JSON.parse(readFileSync("deployments/sepolia.example.json", "utf8"));
    assert.equal(example.schemaVersion, 1);
    assert.equal(example.chainId, 11155111);
    assert.equal(example.abi, "abi/ConsentCraftMarket.json");
    assert.match(example.policies[0].label, /SAMPLE/);
    assert.equal(example.policies[0].feeBps, 500);
    assert.equal(example.policies[0].appealDuration, "120");
    assert.equal(example.policies[0].appealResolutionDuration, "300");
    assert.equal(example.policies[0].refundDelay, "300");
  });

  it("backend signing helpers (raw private keys, as in production) are accepted by the contract", async () => {
    const f = await deployMarket(viem);
    // A backend key that is not a Hardhat-managed account.
    const backend = privateKeyToAccount(`0x${"11".repeat(32)}`);
    await f.market.write.grantRole([await f.market.read.QUOTE_SIGNER_ROLE(), backend.address]);
    await f.market.write.grantRole([await f.market.read.REPORTER_ROLE(), backend.address]);
    const now = BigInt(await networkHelpers.time.latest());

    const quote = sampleQuote(f.author.account.address, now, { nonce: randomNonce() });
    const cert = { wallet: f.author.account.address, action: PersonhoodAction.Publish, expiresAt: now + 600n, nonce: randomNonce() };
    await f.market.write.createPublication(
      [
        quote,
        await signPublicationQuote(backend, f.chainId, f.market.address, quote),
        cert,
        await signPersonhoodCertificate(backend, f.chainId, f.market.address, cert),
      ],
      { account: f.author.account, value: quote.deposit },
    );
    const report = sampleReport(1n, quote, { jobId: randomBytes32() });
    await f.market.write.submitReviewReport([1n, report, await signReviewReport(backend, f.chainId, f.market.address, report)]);
    assert.equal((await f.market.read.getPublication([1n])).state, 3); // Approved
  });
});
