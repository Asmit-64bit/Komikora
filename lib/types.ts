export type User = { id: string; name: string; color: string; address: `0x${string}` };
export type Member = { userId: string; name: string; role: string; share: number; address?: string };
export type Panel = { image: string; dialogue: string; alt: string };
export type Project = {
  id: string; title: string; description: string; ownerId: string; theme: string;
  genre: string; members: Member[]; panels: Panel[]; state: "draft" | "review" | "published";
  revision: number; version: number; approvals: string[]; terms: string;
  rosterFrozen: boolean; createdAt: string; updatedAt: string; publishedAt?: string;
  events: { id: string; text: string; at: string }[]; sample?: boolean;
  priceWei?: string; review?: ChainReview; reviewHistory?: ChainReview[];
  chainTransactions?: ChainTransaction[];
  chainError?: string;
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
export type Invitation = { id: string; projectId: string; address: `0x${string}`; expiresAt: string; accepted: boolean };
export type IncomingInvitation = Invitation & { projectTitle: string; ownerName: string };
export type AppData = { user: User | null; projects: Project[]; comics: Project[]; invitations: IncomingInvitation[] };
