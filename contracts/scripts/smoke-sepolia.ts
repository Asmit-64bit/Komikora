/**
 * End-to-end smoke test against a deployed ConsentCraftMarket:
 *   create publication -> submit review report -> publish -> purchase -> withdraw
 *
 *   npm run contracts:smoke:sepolia    (from the repo root; reads contracts/.env)
 *   npm run contracts:smoke:local      (after contracts:deploy:local; reads contracts/local-node.env)
 *
 * Uses real wallets and spends real (test) ETH:
 *   author pays the deposit (0.001 ETH) and gas; buyer pays the price (0.0002 ETH) and gas.
 * The deposit stays locked in the contract until a refund or threshold settlement.
 *
 * Required environment:
 *   SMOKE_AUTHOR_PRIVATE_KEY, SMOKE_BUYER_PRIVATE_KEY   funded test wallets (not role holders)
 *   QUOTE_SIGNER_PRIVATE_KEY                             key holding QUOTE_SIGNER_ROLE
 *   REPORTER_PRIVATE_KEY                                 key holding REPORTER_ROLE
 * Optional:
 *   MARKET_ADDRESS        default: address in deployments/<network>.json
 *   SMOKE_POLICY_ID       default: the first policy in the deployment file, else 1
 *   ARWEAVE_BUNDLE_TX_ID, ARWEAVE_PREVIEW_TX_ID   real 43-character Arweave IDs
 *   MANIFEST_HASH, PREVIEW_MANIFEST_HASH          0x-prefixed bytes32 hashes of the real manifests
 * Without the Arweave and manifest values, clearly labeled TEST PLACEHOLDERS are used.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { network } from "hardhat";
import { createWalletClient, custom, getAddress, isAddress, isHex, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, sepolia } from "viem/chains";

import { arweaveTxIdToBytes32, bytes32ToArweaveTxId } from "../lib/arweave-tx-id.js";
import type { MarketDeployment } from "../lib/deployment.js";
import {
  PersonhoodAction,
  randomBytes32,
  randomNonce,
  signPersonhoodCertificate,
  signPublicationQuote,
  signReviewReport,
  type PersonhoodCertificate,
  type PublicationQuote,
  type ReviewReport,
} from "../lib/eip712.js";

const SEPOLIA_CHAIN_ID = 11155111;
const LOCAL_CHAIN_ID = 31337;

/** Smoke amounts. Must fit the deployed policy's price bounds. */
const DEPOSIT = parseEther("0.001");
const AI_CAP = parseEther("0.0002");
const AI_COST = parseEther("0.0001");
const PRICE = parseEther("0.0002");
const State = ["Deposited", "Flagged", "AppealPending", "Approved", "Published", "Rejected"];

function requireKey(name: string): Hex {
  const v = process.env[name]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`Missing or malformed ${name} (0x + 64 hex chars)`);
  return v as Hex;
}

const connection = await network.create();
const { viem, networkName, provider } = connection;
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID && chainId !== LOCAL_CHAIN_ID) throw new Error(`Unsupported chain ${chainId}`);
const chain = chainId === SEPOLIA_CHAIN_ID ? sepolia : hardhat;
const explorer = (hash: Hex) => (chainId === SEPOLIA_CHAIN_ID ? `https://sepolia.etherscan.io/tx/${hash}` : hash);

// ---------------------------------------------------------------- configuration
const deploymentPath = resolve(`deployments/${networkName}.json`);
const deployment: MarketDeployment | undefined = existsSync(deploymentPath)
  ? JSON.parse(readFileSync(deploymentPath, "utf8"))
  : undefined;
const marketAddress = (process.env.MARKET_ADDRESS?.trim() || deployment?.address) as Address | undefined;
if (!marketAddress || !isAddress(marketAddress)) throw new Error("Set MARKET_ADDRESS or deploy first");
const policyId = BigInt(process.env.SMOKE_POLICY_ID?.trim() || deployment?.policies[0]?.id || "1");

const author = privateKeyToAccount(requireKey("SMOKE_AUTHOR_PRIVATE_KEY"));
const buyer = privateKeyToAccount(requireKey("SMOKE_BUYER_PRIVATE_KEY"));
const quoteSigner = privateKeyToAccount(requireKey("QUOTE_SIGNER_PRIVATE_KEY"));
const reporter = privateKeyToAccount(requireKey("REPORTER_PRIVATE_KEY"));
if (author.address === buyer.address) throw new Error("Use different author and buyer wallets");

const wallet = (account: typeof author) => createWalletClient({ account, chain, transport: custom(provider) });
const authorWallet = wallet(author);
const buyerWallet = wallet(buyer);
const market = await viem.getContractAt("ConsentCraftMarket", marketAddress);

function arweaveId(envName: string, label: string): { bytes32: Hex; display: string; placeholder: boolean } {
  const real = process.env[envName]?.trim();
  if (real) return { bytes32: arweaveTxIdToBytes32(real), display: real, placeholder: false };
  // Deterministic, clearly labeled placeholder. NOT a real Arweave transaction.
  const bytes32 = keccak256(toHex(`CONSENTCRAFT TEST PLACEHOLDER - NOT A REAL ARWEAVE TX - ${label}`));
  return { bytes32, display: `${bytes32ToArweaveTxId(bytes32)} (TEST PLACEHOLDER)`, placeholder: true };
}
function manifestHash(envName: string, label: string): { value: Hex; placeholder: boolean } {
  const real = process.env[envName]?.trim();
  if (real) {
    if (!isHex(real) || real.length !== 66) throw new Error(`${envName} must be a 0x-prefixed bytes32`);
    return { value: real, placeholder: false };
  }
  return { value: keccak256(toHex(`CONSENTCRAFT TEST PLACEHOLDER MANIFEST - ${label}`)), placeholder: true };
}

const bundle = arweaveId("ARWEAVE_BUNDLE_TX_ID", "bundle");
const preview = arweaveId("ARWEAVE_PREVIEW_TX_ID", "preview");
const manifest = manifestHash("MANIFEST_HASH", "bundle");
const previewManifest = manifestHash("PREVIEW_MANIFEST_HASH", "preview");
const usesPlaceholders = bundle.placeholder || preview.placeholder || manifest.placeholder || previewManifest.placeholder;

console.log(`Smoke test on ${networkName} (chain ${chainId}) against ${marketAddress}, policy ${policyId}`);
console.log(`Author ${author.address}  Buyer ${buyer.address}`);
console.log(`Arweave bundle:  ${bundle.display}`);
console.log(`Arweave preview: ${preview.display}`);
if (usesPlaceholders) {
  console.log("\n*** TEST VALUES: placeholder Arweave IDs and/or manifest hashes are in use. They point to no real");
  console.log("*** Arweave data and are permanently recorded on chain for this smoke publication only.\n");
}

const policy = await market.read.getPolicy([policyId]);
if (PRICE < policy.minPrice || PRICE > policy.maxPrice) throw new Error("Smoke PRICE is outside the policy bounds");
if (!(await market.read.hasRole([await market.read.QUOTE_SIGNER_ROLE(), quoteSigner.address]))) {
  throw new Error("QUOTE_SIGNER_PRIVATE_KEY does not hold QUOTE_SIGNER_ROLE");
}
if (!(await market.read.hasRole([await market.read.REPORTER_ROLE(), reporter.address]))) {
  throw new Error("REPORTER_PRIVATE_KEY does not hold REPORTER_ROLE");
}

async function send(label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${explorer(hash)}`);
  console.log(`  ✓ ${label}  ${explorer(hash)}`);
  return receipt;
}
const nowSeconds = async () => (await publicClient.getBlock()).timestamp;

// ---------------------------------------------------------------- 1. create publication
const quote: PublicationQuote = {
  author: author.address,
  manifestHash: manifest.value,
  previewManifestHash: previewManifest.value,
  arweaveBundleTxId: bundle.bytes32,
  arweavePreviewTxId: preview.bytes32,
  pageCount: 1,
  policyId,
  price: PRICE,
  deposit: DEPOSIT,
  aiCap: AI_CAP,
  ratingSnapshot: 0,
  expiresAt: (await nowSeconds()) + 15n * 60n,
  nonce: randomNonce(),
};
const publishCert: PersonhoodCertificate = {
  wallet: author.address,
  action: PersonhoodAction.Publish,
  expiresAt: quote.expiresAt,
  nonce: randomNonce(),
};
console.log("1. createPublication");
const createReceipt = await send(
  "createPublication",
  await authorWallet.writeContract({
    address: marketAddress,
    abi: market.abi,
    functionName: "createPublication",
    args: [
      quote,
      await signPublicationQuote(quoteSigner, chainId, marketAddress, quote),
      publishCert,
      await signPersonhoodCertificate(quoteSigner, chainId, marketAddress, publishCert),
    ],
    value: DEPOSIT,
  }),
);
const created = await market.getEvents.PublicationCreated({}, { blockHash: createReceipt.blockHash });
const mine = created.find((e) => e.transactionHash === createReceipt.transactionHash);
if (!mine?.args.publicationId) throw new Error("PublicationCreated not found");
const id = mine.args.publicationId;
console.log(`  publicationId ${id}`);

// ---------------------------------------------------------------- 2. review report
const report: ReviewReport = {
  publicationId: id,
  manifestHash: quote.manifestHash,
  arweaveBundleTxId: quote.arweaveBundleTxId,
  reportHash: keccak256(toHex(`SMOKE TEST review record ${id}`)),
  modelVersion: keccak256(toHex("SMOKE TEST model")),
  promptVersion: keccak256(toHex("SMOKE TEST prompt")),
  policyId,
  score: 80,
  flagged: false,
  aiCost: AI_COST,
  jobId: randomBytes32(),
};
console.log("2. submitReviewReport (relayed by the author wallet)");
await send(
  "submitReviewReport",
  await authorWallet.writeContract({
    address: marketAddress,
    abi: market.abi,
    functionName: "submitReviewReport",
    args: [id, report, await signReviewReport(reporter, chainId, marketAddress, report)],
  }),
);

// ---------------------------------------------------------------- 3. publish
console.log("3. publish");
await send(
  "publish",
  await authorWallet.writeContract({ address: marketAddress, abi: market.abi, functionName: "publish", args: [id] }),
);

// ---------------------------------------------------------------- 4. purchase
const purchaseCert: PersonhoodCertificate = {
  wallet: buyer.address,
  action: PersonhoodAction.Purchase,
  expiresAt: (await nowSeconds()) + 15n * 60n,
  nonce: randomNonce(),
};
const requestId = randomBytes32();
console.log("4. purchase");
await send(
  "purchase",
  await buyerWallet.writeContract({
    address: marketAddress,
    abi: market.abi,
    functionName: "purchase",
    args: [
      id,
      requestId,
      purchaseCert,
      policy.purchaseRequiresPersonhood
        ? await signPersonhoodCertificate(quoteSigner, chainId, marketAddress, purchaseCert)
        : "0x",
    ],
    value: PRICE,
  }),
);
if (!(await market.read.hasReadingAccess([id, buyer.address]))) throw new Error("buyer has no reading access");
console.log("  buyer has reading access");

// ---------------------------------------------------------------- 5. withdraw
const credit = await market.read.creditOf([author.address]);
console.log(`5. withdraw (author credit ${credit} wei)`);
const before = await publicClient.getBalance({ address: author.address });
const withdrawReceipt = await send(
  "withdraw",
  await authorWallet.writeContract({ address: marketAddress, abi: market.abi, functionName: "withdraw" }),
);
const after = await publicClient.getBalance({ address: author.address });
const gas = withdrawReceipt.gasUsed * withdrawReceipt.effectiveGasPrice;
if (after !== before + credit - gas) throw new Error("withdrawal amount mismatch");
if ((await market.read.creditOf([author.address])) !== 0n) throw new Error("credit not cleared");

// ---------------------------------------------------------------- summary
const p = await market.read.getPublication([id]);
console.log("\nResult");
console.log(`  state ${State[p.state]}, grossSales ${p.grossSales}, aiCost ${p.aiCost}`);
console.log(`  refund eligible at ${new Date(Number(p.refundEligibleAt) * 1000).toISOString()}`);
console.log(`  liabilities covered: ${await market.read.liabilitiesCovered()}`);
console.log(`  author withdrew ${credit} wei; the ${DEPOSIT - AI_COST} wei deposit remainder stays locked until refund`);
console.log(`  Arweave bundle stored on chain: ${bytes32ToArweaveTxId(p.arweaveBundleTxId)}${bundle.placeholder ? " (TEST PLACEHOLDER)" : ""}`);
console.log(`  author address checksum: ${getAddress(p.author)}`);
console.log("\nSmoke test passed.");
