import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { IndexerConfig } from "./types.ts";

/** Hard limit from the SDK: no entity may live more than ~182 days (7,884,000 blocks of 2 s). */
export const MAX_TTL_DAYS = 182;

export type Env = Record<string, string | undefined>;

export type RuntimeConfig = {
  indexer: IndexerConfig;
  sourceRpcUrl?: string;
  arkivAccessKey: string;
  arkivPrivateKey?: Hex;
  writer?: Address;
  arweaveGateway: string;
  statePath: string;
  pollMs: number;
  renewEveryMs: number;
};

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

/**
 * Reads configuration from the environment. Market address, chain and start block default to
 * contracts/deployments/sepolia.json when it exists.
 */
export function loadConfig(env: Env = process.env, cwd = process.cwd()): RuntimeConfig {
  const deploymentPath = resolve(cwd, env.INDEXER_DEPLOYMENT_FILE ?? "../contracts/deployments/sepolia.json");
  const deployment = existsSync(deploymentPath)
    ? (JSON.parse(readFileSync(deploymentPath, "utf8")) as { chainId: number; address: string; startBlock: string })
    : undefined;

  const contractRaw = env.INDEXER_MARKET_ADDRESS?.trim() || deployment?.address;
  if (!contractRaw || !isAddress(contractRaw)) {
    throw new Error(`Set INDEXER_MARKET_ADDRESS or provide ${deploymentPath} (the market is not deployed yet)`);
  }
  const chainId = int(env, "INDEXER_SOURCE_CHAIN_ID", deployment?.chainId ?? 11155111, 1);
  const startBlock = BigInt(env.INDEXER_START_BLOCK?.trim() || deployment?.startBlock || "0");
  const ttlDays = int(env, "ARKIV_ENTITY_TTL_DAYS", 180, 1);
  if (ttlDays > MAX_TTL_DAYS) throw new Error(`ARKIV_ENTITY_TTL_DAYS cannot exceed ${MAX_TTL_DAYS}`);
  const renewBeforeDays = int(env, "ARKIV_RENEW_BEFORE_DAYS", 30, 1);
  if (renewBeforeDays >= ttlDays) throw new Error("ARKIV_RENEW_BEFORE_DAYS must be smaller than ARKIV_ENTITY_TTL_DAYS");

  const pk = env.ARKIV_PRIVATE_KEY?.trim();
  if (pk && !(isHex(pk) && pk.length === 66)) throw new Error("ARKIV_PRIVATE_KEY must be 0x + 64 hex characters");
  const writerRaw = env.ARKIV_WRITER_ADDRESS?.trim();
  const writer = pk ? privateKeyToAccount(pk as Hex).address : writerRaw && isAddress(writerRaw) ? getAddress(writerRaw) : undefined;

  const contract = getAddress(contractRaw);
  return {
    indexer: {
      chainId,
      contract,
      startBlock,
      confirmations: int(env, "INDEXER_CONFIRMATIONS", 12, 0),
      batchBlocks: int(env, "INDEXER_BATCH_BLOCKS", 2000, 1),
      ttlDays,
      renewBeforeDays,
      retry: { attempts: int(env, "INDEXER_RETRY_ATTEMPTS", 5, 1), baseDelayMs: int(env, "INDEXER_RETRY_BASE_MS", 1000, 0) },
      metadataRetryMs: int(env, "INDEXER_METADATA_RETRY_MS", 60_000, 0),
      metadataMaxAttempts: int(env, "INDEXER_METADATA_MAX_ATTEMPTS", 8, 1),
    },
    ...(env.INDEXER_SOURCE_RPC_URL?.trim() && { sourceRpcUrl: env.INDEXER_SOURCE_RPC_URL.trim() }),
    arkivAccessKey: env.ARKIV_ACCESS_KEY?.trim() ?? "",
    ...(pk && { arkivPrivateKey: pk as Hex }),
    ...(writer && { writer }),
    arweaveGateway: env.ARWEAVE_GATEWAY?.trim() || "https://arweave.net",
    statePath: resolve(cwd, env.INDEXER_STATE_FILE ?? `.state/${chainId}-${contract.toLowerCase()}.json`),
    pollMs: int(env, "INDEXER_POLL_MS", 12_000, 1000),
    renewEveryMs: int(env, "INDEXER_RENEW_EVERY_MS", 6 * 3600 * 1000, 60_000),
  };
}
