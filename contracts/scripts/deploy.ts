/**
 * Deploys ConsentCraftMarket, grants roles from environment variables, creates the
 * SAMPLE demo policy and writes deployments/<network>.json.
 *
 *   npm run contracts:deploy:sepolia   (from the repo root; reads contracts/.env)
 *   npm run contracts:deploy:local     (against `npm run contracts:node`; reads contracts/local-node.env)
 *
 * Required environment:
 *   OWNER_RECIPIENT, AI_EXPENSE_RECIPIENT, QUOTE_SIGNER_ADDRESS, REPORTER_ADDRESS,
 *   REVIEWER_ADDRESS, PAUSER_ADDRESS
 * Optional:
 *   ADMIN_ADDRESS        final DEFAULT_ADMIN_ROLE holder (default: the deployer). When it
 *                        differs, the deployer grants it admin and then renounces its own.
 *   DEPLOYMENTS_OUT      output path (default deployments/<network>.json)
 *   DEPLOY_OVERWRITE=1   allow replacing an existing deployment file
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { network } from "hardhat";
import { getAddress, isAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";

import { EIP712_NAME, EIP712_VERSION } from "../lib/eip712.js";
import type { DeployedPolicy, MarketDeployment } from "../lib/deployment.js";

const SEPOLIA_CHAIN_ID = 11155111;
const LOCAL_CHAIN_ID = 31337;

/**
 * SAMPLE VALUES for a testnet demo. Not an approved launch configuration: fees, price
 * bounds and especially the minute-scale durations exist only so the full lifecycle can
 * be demonstrated quickly. Policies are immutable once created.
 */
const SAMPLE_POLICY = {
  minFee: parseEther("0.00001"),
  minPrice: parseEther("0.0001"),
  maxPrice: parseEther("0.01"),
  feeBps: 500,
  appealDuration: 2n * 60n,
  appealResolutionDuration: 5n * 60n,
  refundDelay: 5n * 60n,
  purchaseRequiresPersonhood: true,
};
const SAMPLE_POLICY_LABEL = "SAMPLE demo policy - testnet values, not approved launch configuration";

function requireAddress(name: string): Address {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`${name} must be a non-zero address, got "${value}"`);
  }
  return getAddress(value);
}

const connection = await network.create();
const { viem, networkName } = connection;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

if (chainId !== SEPOLIA_CHAIN_ID && chainId !== LOCAL_CHAIN_ID) {
  throw new Error(`Refusing to deploy to chain ${chainId}; only Sepolia (${SEPOLIA_CHAIN_ID}) or local (${LOCAL_CHAIN_ID})`);
}

const env = {
  ownerRecipient: requireAddress("OWNER_RECIPIENT"),
  aiExpenseRecipient: requireAddress("AI_EXPENSE_RECIPIENT"),
  quoteSigner: requireAddress("QUOTE_SIGNER_ADDRESS"),
  reporter: requireAddress("REPORTER_ADDRESS"),
  reviewer: requireAddress("REVIEWER_ADDRESS"),
  pauser: requireAddress("PAUSER_ADDRESS"),
  admin: process.env.ADMIN_ADDRESS?.trim() ? requireAddress("ADMIN_ADDRESS") : getAddress(deployer.account.address),
};

const outPath = resolve(process.env.DEPLOYMENTS_OUT ?? `deployments/${networkName}.json`);
if (existsSync(outPath) && process.env.DEPLOY_OVERWRITE !== "1") {
  throw new Error(`${outPath} already exists. Set DEPLOY_OVERWRITE=1 to replace it.`);
}

const balance = await publicClient.getBalance({ address: deployer.account.address });
console.log(`Network:  ${networkName} (chain ${chainId})`);
console.log(`Deployer: ${deployer.account.address} (balance ${balance} wei)`);
console.log("Roles and recipients:", env);

async function waitFor(label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ✓ ${label}  ${hash}`);
  return receipt;
}

// The deployer is the initial admin so it can grant roles; it hands over at the end.
const constructorArgs: MarketDeployment["constructorArgs"] = [
  getAddress(deployer.account.address),
  env.ownerRecipient,
  env.aiExpenseRecipient,
];
const { contract: market, deploymentTransaction } = await viem.sendDeploymentTransaction(
  "ConsentCraftMarket",
  constructorArgs,
);
const deployReceipt = await waitFor("deploy ConsentCraftMarket", deploymentTransaction.hash);
console.log(`  address: ${market.address}`);

const roles = {
  QUOTE_SIGNER_ROLE: env.quoteSigner,
  REPORTER_ROLE: env.reporter,
  REVIEWER_ROLE: env.reviewer,
  PAUSER_ROLE: env.pauser,
} as const;
for (const [name, holder] of Object.entries(roles) as [keyof typeof roles, Address][]) {
  const role = await market.read[name]();
  await waitFor(`grant ${name} to ${holder}`, await market.write.grantRole([role, holder]));
}

await waitFor("create SAMPLE policy", await market.write.createPolicy([SAMPLE_POLICY]));
const policyId = await market.read.policyCount();

const adminRole = await market.read.DEFAULT_ADMIN_ROLE();
if (env.admin !== getAddress(deployer.account.address)) {
  await waitFor(`grant DEFAULT_ADMIN_ROLE to ${env.admin}`, await market.write.grantRole([adminRole, env.admin]));
  await waitFor(
    "deployer renounces DEFAULT_ADMIN_ROLE",
    await market.write.renounceRole([adminRole, deployer.account.address]),
  );
}

// Read back the final state rather than trusting the transactions above.
for (const [name, holder] of Object.entries(roles) as [keyof typeof roles, Address][]) {
  if (!(await market.read.hasRole([await market.read[name](), holder]))) throw new Error(`${name} not granted`);
}
if (!(await market.read.hasRole([adminRole, env.admin]))) throw new Error("admin not set");
if (env.admin !== getAddress(deployer.account.address) && (await market.read.hasRole([adminRole, deployer.account.address]))) {
  throw new Error("deployer still holds DEFAULT_ADMIN_ROLE");
}
const policy = await market.read.getPolicy([policyId]);
const block = await publicClient.getBlock({ blockNumber: deployReceipt.blockNumber });

const deployedPolicy: DeployedPolicy = {
  id: policyId.toString(),
  label: SAMPLE_POLICY_LABEL,
  minFee: policy.minFee.toString(),
  minPrice: policy.minPrice.toString(),
  maxPrice: policy.maxPrice.toString(),
  feeBps: policy.feeBps,
  appealDuration: policy.appealDuration.toString(),
  appealResolutionDuration: policy.appealResolutionDuration.toString(),
  refundDelay: policy.refundDelay.toString(),
  purchaseRequiresPersonhood: policy.purchaseRequiresPersonhood,
};

const record: MarketDeployment = {
  schemaVersion: 1,
  network: networkName,
  chainId,
  contract: "ConsentCraftMarket",
  address: getAddress(market.address),
  deployer: getAddress(deployer.account.address),
  transactionHash: deploymentTransaction.hash,
  blockNumber: deployReceipt.blockNumber.toString(),
  deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  startBlock: deployReceipt.blockNumber.toString(),
  constructorArgs,
  admin: env.admin,
  ownerRecipient: env.ownerRecipient,
  aiExpenseRecipient: env.aiExpenseRecipient,
  roles: {
    QUOTE_SIGNER_ROLE: [env.quoteSigner],
    REPORTER_ROLE: [env.reporter],
    REVIEWER_ROLE: [env.reviewer],
    PAUSER_ROLE: [env.pauser],
  },
  policies: [deployedPolicy],
  eip712: { name: EIP712_NAME, version: EIP712_VERSION },
  compiler: { solc: "0.8.28", optimizer: { enabled: true, runs: 200 } },
  abi: "abi/ConsentCraftMarket.json",
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\nWrote ${outPath}`);
if (chainId === SEPOLIA_CHAIN_ID) {
  console.log("\nVerify on Etherscan with:");
  console.log(`  npm run contracts:verify:sepolia -- ${market.address} ${constructorArgs.join(" ")}`);
  console.log(`\nSet NEXT_PUBLIC_MARKETPLACE_ADDRESS=${market.address} in the web app's .env.local.`);
}
