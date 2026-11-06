/**
 * Format of deployments/<network>.json, written by scripts/deploy.ts and read by the
 * smoke script, the backend and the indexer. Amounts are decimal wei strings.
 */
import type { Address, Hex } from "viem";

export type DeployedPolicy = {
  id: string;
  /** Always present for policies created by the deploy script. */
  label: string;
  minFee: string;
  minPrice: string;
  maxPrice: string;
  feeBps: number;
  appealDuration: string;
  appealResolutionDuration: string;
  refundDelay: string;
  purchaseRequiresPersonhood: boolean;
};

export type MarketDeployment = {
  /** Format version of this file. */
  schemaVersion: 1;
  network: string;
  chainId: number;
  contract: "ConsentCraftMarket";
  address: Address;
  deployer: Address;
  transactionHash: Hex;
  blockNumber: string;
  deployedAt: string;
  /** First block an indexer must scan for events. */
  startBlock: string;
  constructorArgs: [admin: Address, ownerRecipient: Address, aiExpenseRecipient: Address];
  admin: Address;
  ownerRecipient: Address;
  aiExpenseRecipient: Address;
  roles: {
    QUOTE_SIGNER_ROLE: Address[];
    REPORTER_ROLE: Address[];
    REVIEWER_ROLE: Address[];
    PAUSER_ROLE: Address[];
  };
  policies: DeployedPolicy[];
  eip712: { name: string; version: string };
  compiler: { solc: string; optimizer: { enabled: boolean; runs: number } };
  abi: string;
};
