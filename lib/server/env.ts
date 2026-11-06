import "server-only";
// Server configuration. Every integration fails closed: a missing key disables
// that feature with a clear message. Nothing ever falls back to a mock result.
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { AppError } from "@/lib/store";
import { configuredAppOrigin } from "./app-origin";

export class NotConfiguredError extends AppError {
  constructor(feature: string, missing: string[]) {
    super(`${feature} is not configured on this server (missing ${missing.join(", ")}).`, 503);
  }
}

const value = (name: string) => process.env[name]?.trim() || undefined;

/** The one origin this app is served from. Sign-in messages are pinned to it. */
export function appOrigin(): string {
  const origin = configuredAppOrigin();
  if (!origin) throw new NotConfiguredError("Sign-in", ["APP_ORIGIN"]);
  return origin;
}

export function privateKey(name: string, feature: string): Hex {
  const key = value(name);
  if (!key) throw new NotConfiguredError(feature, [name]);
  if (!isHex(key) || key.length !== 66) throw new AppError(`${name} must be a 0x-prefixed 32-byte hex key.`, 500);
  return key;
}

export function hasKey(name: string) {
  const key = value(name);
  return !!key && isHex(key) && key.length === 66;
}

export type ChainConfig = { chainId: number; rpcUrl: string; market: Address; startBlock: bigint; confirmations: number };

export function chainConfig(): ChainConfig {
  const missing = ["NEXT_PUBLIC_CHAIN_ID", "NEXT_PUBLIC_MARKETPLACE_ADDRESS"].filter(n => !value(n));
  const rpcUrl = value("CHAIN_RPC_URL") || value("NEXT_PUBLIC_RPC_URL");
  if (!rpcUrl) missing.push("CHAIN_RPC_URL");
  if (missing.length) throw new NotConfiguredError("The marketplace contract", missing);
  const market = value("NEXT_PUBLIC_MARKETPLACE_ADDRESS")!;
  if (!isAddress(market)) throw new AppError("NEXT_PUBLIC_MARKETPLACE_ADDRESS is not an address.", 500);
  const chainId = Number(value("NEXT_PUBLIC_CHAIN_ID"));
  return {
    chainId,
    rpcUrl: rpcUrl!,
    market: getAddress(market),
    startBlock: BigInt(value("MARKET_START_BLOCK") || "0"),
    // Local Hardhat mines instantly; public chains need reorg protection.
    confirmations: Number(value("CHAIN_CONFIRMATIONS") || (chainId === 31337 ? "0" : "2")),
  };
}

/** Amounts the server offers in publication quotes (wei). Deposit must exceed the AI cap. */
export function publishingTerms() {
  const deposit = BigInt(value("PUBLISH_DEPOSIT_WEI") || "5000000000000000"); // 0.005 ETH
  const aiCap = BigInt(value("PUBLISH_AI_CAP_WEI") || "500000000000000"); // 0.0005 ETH
  const policyId = BigInt(value("PUBLISH_POLICY_ID") || "1");
  if (aiCap >= deposit) throw new AppError("PUBLISH_AI_CAP_WEI must be below PUBLISH_DEPOSIT_WEI.", 500);
  return { deposit, aiCap, policyId };
}

export { value as envValue };
