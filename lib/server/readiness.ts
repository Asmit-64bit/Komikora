import "server-only";
import { createPublicClient, http, isAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { editionsAbi } from "@/lib/editions-abi";
import { editionPermitTypes } from "@/lib/edition-permit";
import { envValue, hasKey } from "./env";
import { DEFAULT_PRIVATE_MODEL } from "./private-computer";
export type ServiceReadiness = { name: string; status: "ready" | "missing" | "unverified" | "error"; detail: string; fields: string[]; link?: string };
export async function integrationReadiness(probe = false): Promise<ServiceReadiness[]> {
  const rows: ServiceReadiness[] = [];
  const storageDriver = envValue("STUDIO_STORAGE") || (process.env.VERCEL === "1" ? "postgres" : "file");
  const sqlConfigured = !!(envValue("STUDIO_DATABASE_URL") || envValue("DATABASE_URL") || envValue("POSTGRES_URL"));
  let storageStatus: ServiceReadiness["status"] = storageDriver === "postgres" ? sqlConfigured ? "unverified" : "missing" : process.env.VERCEL === "1" ? "error" : "ready";
  let storageDetail = storageDriver === "postgres" ? "Persistent PostgreSQL stores wallet sessions, drafts and encrypted content keys." : "Local file storage is active; it requires a persistent disk and a single application process.";
  if (process.env.VERCEL === "1" && storageDriver !== "postgres") storageDetail = "Vercel requires PostgreSQL storage. Local files cannot persist wallet sessions.";
  if (probe && storageDriver === "postgres" && sqlConfigured) {
    try { const { database } = await import("@/lib/store"); await database(db => db.users.length); storageStatus = "ready"; }
    catch { storageStatus = "error"; storageDetail = "The studio database cannot be reached. Check the hosted connection and database permissions."; }
  }
  rows.push({ name: "Studio sessions and data", status: storageStatus, detail: storageDetail, fields: storageDriver === "postgres" && !sqlConfigured ? ["STUDIO_DATABASE_URL"] : [] });
  const missing = (fields: string[]) => fields.filter(f => !envValue(f));
  const rpc = envValue("CHAIN_RPC_URL") || envValue("NEXT_PUBLIC_RPC_URL");
  const address = envValue("NEXT_PUBLIC_EDITIONS_ADDRESS"); const chainId = Number(envValue("NEXT_PUBLIC_CHAIN_ID"));
  const chainFields = missing(["NEXT_PUBLIC_CHAIN_ID", "NEXT_PUBLIC_EDITIONS_ADDRESS"]); if (!rpc) chainFields.push("CHAIN_RPC_URL");
  let chainDetail = "Configured. Run connection checks to confirm the network and contract."; let chainStatus: ServiceReadiness["status"] = chainFields.length ? "missing" : "unverified";
  if (probe && !chainFields.length && rpc && address && isAddress(address)) try {
    const client = createPublicClient({ transport: http(rpc, { timeout: 10000, retryCount: 0 }) });
    if (await client.getChainId() !== chainId) throw new Error();
    const code = await client.getCode({ address }); if (!code || code === "0x") throw new Error();
    const reviewer = await client.readContract({ address, abi: editionsAbi, functionName: "reviewer" });
    const permitHash = await client.readContract({ address, abi: editionsAbi, functionName: "PERMIT_TYPEHASH" });
    if (permitHash !== keccak256(toHex(`Permit(${editionPermitTypes.Permit.map(f => `${f.type} ${f.name}`).join(",")})`))) throw new Error();
    await client.readContract({ address, abi: editionsAbi, functionName: "canTrade", args: [reviewer] });
    if (!hasKey("EDITION_REVIEWER_PRIVATE_KEY")) { chainDetail = "Contract is reachable. Configure the matching reviewer signing key to publish."; chainStatus = "unverified"; }
    else if (privateKeyToAccount(envValue("EDITION_REVIEWER_PRIVATE_KEY") as `0x${string}`).address.toLowerCase() !== reviewer.toLowerCase()) { chainDetail = "The reviewer signing key does not match this contract."; chainStatus = "error"; }
    else { chainDetail = "Network, NFT contract API and reviewer signing key match."; chainStatus = "ready"; }
  } catch { chainDetail = "Could not validate this network and NFT contract. Check the RPC, chain ID and deployment address."; chainStatus = "error"; }
  rows.push({ name: "NFT blockchain", status: chainStatus, detail: chainFields.length ? "A deployment and RPC connection are required." : chainDetail, fields: chainFields, link: chainId === 11155111 && address && isAddress(address) ? `https://sepolia.etherscan.io/address/${address}` : undefined });
  const aiFields = missing(["ZG_COMPUTE_API_KEY"]); let aiStatus: ServiceReadiness["status"] = aiFields.length ? "missing" : "unverified";
  let aiDetail = "Private Computer powers image review and collector suggestions. Model access is checked without generating paid inference.";
  if (probe && !aiFields.length) try {
    const url = new URL(envValue("ZG_COMPUTE_BASE_URL") || "https://router-api.0g.ai/v1");
    if (url.protocol !== "https:") throw new Error();
    const res = await fetch(`${url.href.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${envValue("ZG_COMPUTE_API_KEY")}` }, signal: AbortSignal.timeout(10000), cache: "no-store" });
    const body = await res.json() as { data?: { id: string }[] };
    const model = envValue("ZG_COMPUTE_MODEL") || DEFAULT_PRIVATE_MODEL;
    if (!res.ok || !body.data?.some(m => m.id === model)) throw new Error();
    const providers = await fetch(`${url.href.replace(/\/$/, "")}/providers?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${envValue("ZG_COMPUTE_API_KEY")}` }, signal: AbortSignal.timeout(10000), cache: "no-store" });
    const available = await providers.json() as { data?: { is_healthy?: boolean; trust_mode?: string; tee_acknowledged?: boolean; architecture?: { input_modalities?: string[] } }[] };
    if (!providers.ok || !available.data?.some(p => p.is_healthy && p.trust_mode === "private" && p.tee_acknowledged && p.architecture?.input_modalities?.includes("image"))) throw new Error();
    aiStatus = "unverified"; aiDetail = `Private provider available for ${model}. Each score also requires sealed output and gateway-reported provider checks. This catalog check does not verify inference or balance.`;
  } catch { aiStatus = "error"; aiDetail = "0G model access failed. Check the key, endpoint, model and account permissions."; }
  rows.push({ name: "0G Private Computer", status: aiStatus, detail: aiDetail, fields: aiFields, link: "https://pc.0g.ai/dashboard/api-keys" });
  const storageFields = missing(["ARWEAVE_UPLOAD_PRIVATE_KEY", "CONTENT_KEY_ENCRYPTION_KEY"]);
  rows.push({ name: "Encrypted comic storage", status: storageFields.length ? "missing" : "unverified", detail: "Uploading and reading back a new comic verifies this connection. Preserve encryption keys and back up private data.", fields: storageFields, link: "https://docs.ar.io/" });
  const indexFields = missing(["ARKIV_WRITER_ADDRESS"]);
  rows.push({ name: "Arkiv discovery", status: indexFields.length ? "missing" : "unverified", detail: "Run the NFT indexer against the same contract, then verify an indexed marketplace query. Public RPC access can be rate limited without an access key.", fields: indexFields, link: "https://hub.arkiv.network/access-keys" });
  return rows;
}
