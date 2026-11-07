import "server-only";
import { createPublicClient, defineChain, getAddress, http, isAddress } from "viem";
import { readingAbi } from "@/lib/reading-abi";
import { ensure } from "@/lib/store";
import { envValue, NotConfiguredError } from "./env";
export function readingConfig() {
  const raw = envValue("NEXT_PUBLIC_READING_ADDRESS");
  const rpc = envValue("CHAIN_RPC_URL") || envValue("NEXT_PUBLIC_RPC_URL");
  const chainId = Number(envValue("NEXT_PUBLIC_CHAIN_ID"));
  if (!raw || !rpc || !chainId) throw new NotConfiguredError("Fixed-price reading", ["NEXT_PUBLIC_READING_ADDRESS", "CHAIN_RPC_URL", "NEXT_PUBLIC_CHAIN_ID"]);
  ensure(isAddress(raw) && [31337, 11155111].includes(chainId), "Configure a local or Sepolia reading contract.", 503);
  const chain = defineChain({ id: chainId, name: chainId === 31337 ? "Local Ethereum" : "Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return { address: getAddress(raw), abi: readingAbi, chainId, client: createPublicClient({ chain, transport: http(rpc) }), confirmations: Number(envValue("CHAIN_CONFIRMATIONS") || (chainId === 31337 ? "0" : "2")) };
}
export async function confirmedReading() {
  const cfg = readingConfig(); const head = await cfg.client.getBlockNumber({ cacheTime: 0 });
  return { ...cfg, blockNumber: head > BigInt(cfg.confirmations) ? head - BigInt(cfg.confirmations) : BigInt(0) };
}
