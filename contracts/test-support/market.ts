/**
 * Shared fixtures and EIP-712 signing helpers for ConsentCraftMarket tests.
 * Lives outside test/ because Hardhat runs every file in test/ as a test.
 */
import { randomBytes } from "node:crypto";
import type { network } from "hardhat";
import { keccak256, parseEther, toHex, type Address, type Hex } from "viem";

import { arweaveTxIdToBytes32 } from "../lib/arweave-tx-id.js";

type Connection = Awaited<ReturnType<typeof network.create>>;
export type Viem = Connection["viem"];
type WalletClient = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

export const EIP712_NAME = "ConsentCraftMarket";
export const EIP712_VERSION = "1";

export const Action = { Publish: 0, Purchase: 1 } as const;

export const QUOTE_TYPES = {
  PublicationQuote: [
    { name: "author", type: "address" },
    { name: "manifestHash", type: "bytes32" },
    { name: "previewManifestHash", type: "bytes32" },
    { name: "arweaveBundleTxId", type: "bytes32" },
    { name: "arweavePreviewTxId", type: "bytes32" },
    { name: "pageCount", type: "uint32" },
    { name: "policyId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deposit", type: "uint256" },
    { name: "aiCap", type: "uint256" },
    { name: "ratingSnapshot", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CERTIFICATE_TYPES = {
  PersonhoodCertificate: [
    { name: "wallet", type: "address" },
    { name: "action", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export type Quote = {
  author: Address;
  manifestHash: Hex;
  previewManifestHash: Hex;
  arweaveBundleTxId: Hex;
  arweavePreviewTxId: Hex;
  pageCount: number;
  policyId: bigint;
  price: bigint;
  deposit: bigint;
  aiCap: bigint;
  ratingSnapshot: number;
  expiresAt: bigint;
  nonce: bigint;
};

export type Certificate = {
  wallet: Address;
  action: number;
  expiresAt: bigint;
  nonce: bigint;
};

export type PolicyInput = {
  minFee: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  feeBps: number;
  appealDuration: bigint;
  appealResolutionDuration: bigint;
  refundDelay: bigint;
  purchaseRequiresPersonhood: boolean;
};

const HOUR = 3600n;
const DAY = 24n * HOUR;

/** Clearly labeled sample configuration for tests; not an approved launch policy. */
export const SAMPLE_POLICY: PolicyInput = {
  minFee: parseEther("0.0001"),
  minPrice: parseEther("0.001"),
  maxPrice: parseEther("0.1"),
  feeBps: 1000,
  appealDuration: 72n * HOUR,
  appealResolutionDuration: 7n * DAY,
  refundDelay: 30n * DAY,
  purchaseRequiresPersonhood: true,
};

// Sample transaction IDs from the Arweave HTTP API documentation.
export const SAMPLE_BUNDLE_TX_ID = arweaveTxIdToBytes32("BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ");
export const SAMPLE_PREVIEW_TX_ID = arweaveTxIdToBytes32("UEVFNJVXSu7GodYbZoldRHGi_tjzNtNcYjeSkxKCpiE");
export const OTHER_TX_ID = arweaveTxIdToBytes32("3pXpj43Tk8QzDAoERjHE3ED7oEKLKephjnVakvkiHF8");

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export const randomNonce = () => BigInt(toHex(randomBytes(32)));

export const roleId = (name: string) => keccak256(toHex(name));

export async function deployMarket(viem: Viem) {
  const wallets = await viem.getWalletClients();
  const [admin, owner, aiRecipient, quoteSigner, author, other, pauser, reporter] = wallets;
  const publicClient = await viem.getPublicClient();

  const market = await viem.deployContract("ConsentCraftMarket", [
    admin.account.address,
    owner.account.address,
    aiRecipient.account.address,
  ]);

  await market.write.grantRole([roleId("QUOTE_SIGNER_ROLE"), quoteSigner.account.address]);
  await market.write.grantRole([roleId("PAUSER_ROLE"), pauser.account.address]);
  await market.write.grantRole([roleId("REPORTER_ROLE"), reporter.account.address]);
  await market.write.createPolicy([SAMPLE_POLICY]);

  const chainId = await publicClient.getChainId();
  return { market, publicClient, chainId, admin, owner, aiRecipient, quoteSigner, author, other, pauser, reporter };
}

export function domainFor(chainId: number, verifyingContract: Address) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract } as const;
}

export function signQuote(signer: WalletClient, chainId: number, market: Address, quote: Quote) {
  return signer.signTypedData({
    account: signer.account,
    domain: domainFor(chainId, market),
    types: QUOTE_TYPES,
    primaryType: "PublicationQuote",
    message: quote,
  });
}

export function signCertificate(signer: WalletClient, chainId: number, market: Address, cert: Certificate) {
  return signer.signTypedData({
    account: signer.account,
    domain: domainFor(chainId, market),
    types: CERTIFICATE_TYPES,
    primaryType: "PersonhoodCertificate",
    message: cert,
  });
}

export function sampleQuote(author: Address, now: bigint, overrides: Partial<Quote> = {}): Quote {
  return {
    author,
    manifestHash: keccak256(toHex("sample bundle manifest")),
    previewManifestHash: keccak256(toHex("sample preview manifest")),
    arweaveBundleTxId: SAMPLE_BUNDLE_TX_ID,
    arweavePreviewTxId: SAMPLE_PREVIEW_TX_ID,
    pageCount: 24,
    policyId: 1n,
    price: parseEther("0.01"),
    deposit: parseEther("0.05"),
    aiCap: parseEther("0.005"),
    ratingSnapshot: 50,
    expiresAt: now + HOUR,
    nonce: randomNonce(),
    ...overrides,
  };
}

export function sampleCertificate(wallet: Address, now: bigint, overrides: Partial<Certificate> = {}): Certificate {
  return { wallet, action: Action.Publish, expiresAt: now + HOUR, nonce: randomNonce(), ...overrides };
}
