export type User = { id: string; name: string; color: string; address: `0x${string}`; username?: string };
export type Member = { userId: string; name: string; role: string; share: number; address?: string };
export type Panel = { image: string; dialogue: string; alt: string };
export type OriginalityResult = {
  version: string; contentHash: `0x${string}`; catalogueHash: `0x${string}`;
  crux: string; maxSimilarity: number; comparedComicCount: string;
  model: string; requestId: string; comparisonRequestIds: string[]; at: string;
  comparisons: { comicId: string; title: string; similarity: number; relevance: string }[];
};
export type Project = {
  id: string; title: string; description: string; ownerId: string; theme: string;
  genre: string; members: Member[]; panels: Panel[]; state: "draft" | "review" | "published";
  revision: number; version: number; approvals: string[]; terms: string;
  rosterFrozen: boolean; createdAt: string; updatedAt: string; publishedAt?: string;
  events: { id: string; text: string; at: string }[]; sample?: boolean;
  priceWei?: string; review?: ChainReview; reviewHistory?: ChainReview[];
  chainTransactions?: ChainTransaction[];
  chainError?: string;
  publicationId?: string;
  publication?: PublicationView;
  edition?: EditionPublication;
  reading?: ReadingPublication;
};
export type ReadingPublication = {
  key: `0x${string}`; contentHash: `0x${string}`; licenseHash: `0x${string}`; contributorsHash: `0x${string}`;
  priceWei: string; approvalDeadline: number; chainId: number; contract: `0x${string}`;
  status: "team-review" | "uploaded" | "flagged" | "approved" | "published";
  approvals: { userId: string; address: `0x${string}`; signature: `0x${string}`; at: string }[];
  manifestHash?: `0x${string}`; bundleTxId?: string; coverTxId?: string;
  uri?: string; metadataHash?: `0x${string}`; comicId?: string; permitExpiresAt?: number;
  review?: EditionPublication["review"]; error?: string;
  originality?: OriginalityResult; metadataOriginalityId?: `0x${string}`;
};
export type EditionPublication = {
  key: `0x${string}`; manifestHash: `0x${string}`; bundleTxId: string; coverTxId: string;
  supply: number; license: string; rightsAt: string; status: "uploaded" | "flagged" | "approved" | "minted";
  chainId: number; contract: `0x${string}`; comicId?: string; uri?: string; metadataHash?: `0x${string}`;
  permitExpiresAt?: number;
  reserveWei?: string; auctionDuration?: number;
  review?: { score: number; flagged: boolean; reasons: string[]; model: string; provider: string; teeVerified: boolean; at: string; promptVersion: string; uncertainty: string; requestId?: string; verification?: string; evidence?: { verification: "gateway-reported"; verdicts: Record<string, string>; osImage?: string; composeHash?: string }; assessment?: { completeness: string; legibility: string; pageOrder: string } };
  error?: string; appeal?: { text: string; at: string; deadline: string; decision?: "approved" | "rejected"; reason?: string; reviewer?: string };
};
export type ChainReview = {
  salt: `0x${string}`; projectKey: `0x${string}`; chainId: number; contract: `0x${string}`;
  manifestUri: string; termsUri: string; metadataUri: string; contentHash: `0x${string}`; termsHash: `0x${string}`;
  contributors: (Member & { address: `0x${string}` })[]; priceWei: string; expectedVersion: number;
  version: number; digest?: `0x${string}`; tokenId?: string; sold?: boolean; tokenOwner?: string;
  storage: "local" | "ipfs"; preparedAt: string; confirmedBlock?: string; status: "prepared" | "proposed" | "minted";
  snapshot: Pick<Project, "title" | "description" | "genre" | "panels" | "terms" | "members">;
};
export type ChainTransaction = { hash: `0x${string}`; action: string; actor: string; at: string; status: "submitted" | "confirmed" | "reverted" | "replaced"; nonce: number; blockNumber?: string; blockHash?: string; transactionIndex?: number; replaces?: string };
export type ChainConfig = { chainId: number; name: string; contract?: `0x${string}`; configured: boolean; confirmations: number; storage: "local" | "ipfs"; deploymentTransaction?: string; error?: string };
export type Invitation = { id: string; projectId: string; address: `0x${string}`; username?: string; expiresAt: string; accepted: boolean };
export type IncomingInvitation = Invitation & { projectTitle: string; ownerName: string };
export type AppData = { user: User | null; projects: Project[]; comics: Project[]; invitations: IncomingInvitation[] };

/** Client-safe publishing state. Content keys and review rationale stay server-side. */
export type PublicationStatus = "quoted" | "created" | "reviewing" | "reviewed" | "review_failed";
export type PublicationView = {
  status: PublicationStatus;
  chainId: number; market: `0x${string}`;
  author: `0x${string}`;
  publicationId?: string;
  manifestHash: `0x${string}`; previewManifestHash: `0x${string}`; previewImageHash?: `0x${string}`;
  bundleTxId: string; previewTxId: string; previewImageTxId: string;
  pageCount: number; language: string;
  priceWei: string; depositWei: string; aiCapWei: string; policyId: string;
  quote?: Record<string, string | number>; quoteSignature?: `0x${string}`; quoteExpiresAt?: number;
  createTx?: `0x${string}`;
  review?: { score: number; flagged: boolean; aiCostWei: string; model: string; provider: string; teeVerified: boolean; inputTokens: number; outputTokens: number; tx?: `0x${string}`; at: string };
  reviewError?: string;
  updatedAt: string;
};
