import "server-only";
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, sepolia } from "viem/chains";
import { consentCraftMarketAbi } from "@/lib/abi";
import { chainConfig, privateKey } from "./env";

function chain(chainId: number, rpcUrl: string) {
  if (chainId === sepolia.id) return sepolia;
  if (chainId === hardhat.id) return hardhat;
  return defineChain({ id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
}

const clients = new Map<string, PublicClient>();
export function publicClient(): PublicClient {
  const { chainId, rpcUrl } = chainConfig();
  const key = `${chainId}:${rpcUrl}`;
  if (!clients.has(key)) clients.set(key, createPublicClient({ chain: chain(chainId, rpcUrl), transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }) }) as PublicClient);
  return clients.get(key)!;
}

export function market() {
  const { market: address } = chainConfig();
  return { address, abi: consentCraftMarketAbi } as const;
}

export async function getPublication(id: bigint) {
  return publicClient().readContract({ ...market(), functionName: "getPublication", args: [id] });
}

export async function getPolicy(id: bigint) {
  return publicClient().readContract({ ...market(), functionName: "getPolicy", args: [id] });
}

/** Reading access at a block that is at least `confirmations` deep. Authors always have access. */
export async function canRead(publicationId: bigint, wallet: Address): Promise<boolean> {
  const client = publicClient();
  const { confirmations } = chainConfig();
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const blockNumber = head > BigInt(confirmations) ? head - BigInt(confirmations) : head;
  const [publication, access] = await Promise.all([
    client.readContract({ ...market(), functionName: "getPublication", args: [publicationId], blockNumber }),
    client.readContract({ ...market(), functionName: "hasReadingAccess", args: [publicationId, wallet], blockNumber }),
  ]);
  return access || publication.author.toLowerCase() === wallet.toLowerCase();
}

export async function hasRole(role: "QUOTE_SIGNER_ROLE" | "REPORTER_ROLE" | "REVIEWER_ROLE" | "PAUSER_ROLE" | "DEFAULT_ADMIN_ROLE", account: Address) {
  const client = publicClient();
  const roleId = await client.readContract({ ...market(), functionName: role });
  return client.readContract({ ...market(), functionName: "hasRole", args: [roleId as Hex, account] });
}

/** Waits for a transaction and the configured confirmations, then returns its market events. */
export async function confirmedMarketEvents(hash: Hash) {
  const client = publicClient();
  const { confirmations } = chainConfig();
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: Math.max(1, confirmations), timeout: 180_000 });
  if (receipt.status !== "success") return { receipt, events: [] };
  const logs = receipt.logs.filter(l => l.address.toLowerCase() === market().address.toLowerCase());
  return { receipt, events: parseEventLogs({ abi: consentCraftMarketAbi, logs }) };
}

/** Finds PublicationCreated events for an author (used to recover after a closed tab). */
export async function publicationsCreatedBy(author: Address) {
  const client = publicClient();
  const { startBlock, confirmations } = chainConfig();
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const toBlock = head > BigInt(confirmations) ? head - BigInt(confirmations) : head;
  return client.getContractEvents({ ...market(), eventName: "PublicationCreated", args: { author }, fromBlock: startBlock, toBlock });
}

/** Any funded account may relay signed review reports. */
export function relayerClient() {
  const { chainId, rpcUrl } = chainConfig();
  const account = privateKeyToAccount(privateKey("RELAYER_PRIVATE_KEY", "Review relaying"));
  return createWalletClient({ account, chain: chain(chainId, rpcUrl), transport: http(rpcUrl) });
}
