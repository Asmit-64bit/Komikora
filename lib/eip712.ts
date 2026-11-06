/**
 * EIP-712 definitions and signing helpers for ConsentCraftMarket.
 *
 * Backend services (quote signer, personhood bridge, reporter) sign with these exact
 * definitions; the contract test suite uses the same objects, so they are verified
 * against the deployed bytecode on every test run.
 */
import type { Address, Hex, LocalAccount } from "viem";

export const EIP712_NAME = "ConsentCraftMarket";
export const EIP712_VERSION = "1";

/** PersonhoodCertificate.action values. */
export const PersonhoodAction = { Publish: 0, Purchase: 1 } as const;
export type PersonhoodAction = (typeof PersonhoodAction)[keyof typeof PersonhoodAction];

export const PUBLICATION_QUOTE_TYPES = {
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

export const PERSONHOOD_CERTIFICATE_TYPES = {
  PersonhoodCertificate: [
    { name: "wallet", type: "address" },
    { name: "action", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const REVIEW_REPORT_TYPES = {
  ReviewReport: [
    { name: "publicationId", type: "uint256" },
    { name: "manifestHash", type: "bytes32" },
    { name: "arweaveBundleTxId", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "modelVersion", type: "bytes32" },
    { name: "promptVersion", type: "bytes32" },
    { name: "policyId", type: "uint256" },
    { name: "score", type: "uint16" },
    { name: "flagged", type: "bool" },
    { name: "aiCost", type: "uint256" },
    { name: "jobId", type: "bytes32" },
  ],
} as const;

export type PublicationQuote = {
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

export type PersonhoodCertificate = {
  wallet: Address;
  action: number;
  expiresAt: bigint;
  nonce: bigint;
};

export type ReviewReport = {
  publicationId: bigint;
  manifestHash: Hex;
  arweaveBundleTxId: Hex;
  reportHash: Hex;
  modelVersion: Hex;
  promptVersion: Hex;
  policyId: bigint;
  score: number;
  flagged: boolean;
  aiCost: bigint;
  jobId: Hex;
};

/** The domain binds chain and deployment, so signatures never replay across either. */
export function marketDomain(chainId: number, verifyingContract: Address) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract } as const;
}

type Signer = Pick<LocalAccount, "signTypedData">;

/** QUOTE_SIGNER_ROLE: sign after confirming both Arweave transactions and hashes. */
export function signPublicationQuote(signer: Signer, chainId: number, market: Address, quote: PublicationQuote) {
  return signer.signTypedData({
    domain: marketDomain(chainId, market),
    types: PUBLICATION_QUOTE_TYPES,
    primaryType: "PublicationQuote",
    message: quote,
  });
}

/** QUOTE_SIGNER_ROLE: trusted bridge from the backend's World ID check. Single use. */
export function signPersonhoodCertificate(
  signer: Signer,
  chainId: number,
  market: Address,
  certificate: PersonhoodCertificate,
) {
  return signer.signTypedData({
    domain: marketDomain(chainId, market),
    types: PERSONHOOD_CERTIFICATE_TYPES,
    primaryType: "PersonhoodCertificate",
    message: certificate,
  });
}

/** REPORTER_ROLE: sign only successful reviews; service errors must never produce a report. */
export function signReviewReport(signer: Signer, chainId: number, market: Address, report: ReviewReport) {
  return signer.signTypedData({
    domain: marketDomain(chainId, market),
    types: REVIEW_REPORT_TYPES,
    primaryType: "ReviewReport",
    message: report,
  });
}

/** Random 256-bit nonce for quotes and certificates. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);
}

/** Random bytes32 for jobId and requestId. Never derive these from private data. */
export function randomBytes32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
