import "server-only";
import { createPublicClient, defineChain, getAddress, http, isAddress } from "viem";
import { editionsAbi } from "@/lib/editions-abi";
import { ensure } from "@/lib/store";
import { envValue, NotConfiguredError } from "./env";
export function nftConfig() {
  const raw = envValue("NEXT_PUBLIC_EDITIONS_ADDRESS");
  const rpc = envValue("CHAIN_RPC_URL") || envValue("NEXT_PUBLIC_RPC_URL");
  const chainId = Number(envValue("NEXT_PUBLIC_CHAIN_ID"));
  if (!raw || !rpc || !chainId) throw new NotConfiguredError("NFT editions", ["NEXT_PUBLIC_EDITIONS_ADDRESS", "CHAIN_RPC_URL", "NEXT_PUBLIC_CHAIN_ID"]);
  ensure(isAddress(raw) && [31337, 11155111].includes(chainId), "Configure a local or Sepolia edition contract.", 503);
  const chain = defineChain({ id: chainId, name: chainId === 31337 ? "Local Ethereum" : "Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return { address: getAddress(raw), abi: editionsAbi, client: createPublicClient({ chain, transport: http(rpc) }), chainId, confirmations: Number(envValue("CHAIN_CONFIRMATIONS") || (chainId === 31337 ? "0" : "2")) };
}
export async function confirmedNFT() {
  const config = nftConfig();
  const head = await config.client.getBlockNumber({ cacheTime: 0 });
  return { ...config, blockNumber: head > BigInt(config.confirmations) ? head - BigInt(config.confirmations) : BigInt(0) };
}
