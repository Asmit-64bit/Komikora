// Which integrations this server has configured. Reports booleans and public ids only.
import { connection } from "next/server";
import { envValue, hasKey } from "@/lib/server/env";
import { json } from "@/lib/server/http";

export async function GET() {
  await connection();
  return json({
    "Chain id": envValue("NEXT_PUBLIC_CHAIN_ID") ?? "not set",
    "Marketplace contract": !!envValue("NEXT_PUBLIC_MARKETPLACE_ADDRESS"),
    "NFT edition contract": !!envValue("NEXT_PUBLIC_EDITIONS_ADDRESS"),
    "NFT reviewer signer": hasKey("EDITION_REVIEWER_PRIVATE_KEY"),
    "NFT Arkiv discovery": !!(envValue("ARKIV_ACCESS_KEY") && envValue("ARKIV_WRITER_ADDRESS")),
    "Legacy quote and authorization signer": hasKey("QUOTE_SIGNER_PRIVATE_KEY"),
    "Review reporter": hasKey("REPORTER_PRIVATE_KEY"),
    "Review relayer": hasKey("RELAYER_PRIVATE_KEY"),
    "Paid page encryption key": hasKey("CONTENT_KEY_ENCRYPTION_KEY"),
    "Arweave uploader": hasKey("ARWEAVE_UPLOAD_PRIVATE_KEY"),
    "Arweave gateway": envValue("ARWEAVE_GATEWAY") || "https://ar-io.dev",
    "0G Compute wallet": hasKey("ZG_PRIVATE_KEY"),
    "0G provider": envValue("ZG_PROVIDER_ADDRESS") ?? "not set",
    "0G price in ETH (per 0G)": envValue("ZG_ETH_PER_0G") ?? "not set",
  });
}
