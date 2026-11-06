import "server-only";
// Marketplace reads. Listings come from contract events and state; display text
// comes from the Arweave preview manifest, accepted only if it matches the on-chain
// previewManifestHash. Paid pages are decrypted only for wallets with reading access.
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { bytes32ToArweaveTxId } from "@/contracts/lib/arweave-tx-id";
import { database, ensure, sessionUser } from "@/lib/store";
import { fetchVerified, gatewayUrl } from "./arweave";
import { canRead, getPublication, market, publicClient } from "./chain";
import { openBundle, unwrapKey } from "./content";
import { chainConfig } from "./env";

const Preview = z.object({
  schema: z.literal("consentcraft.preview.v1"), title: z.string().max(512), description: z.string().max(4000).default(""),
  language: z.string().max(35), genre: z.string().max(64), previewImages: z.array(z.string()).max(32).default([]),
});
type Preview = z.infer<typeof Preview>;

const previews = new Map<string, Preview | null>();
async function preview(txId: string, hash: `0x${string}`) {
  const key = `${txId}:${hash}`;
  if (!previews.has(key)) {
    try {
      const bytes = await fetchVerified(txId, hash, { attempts: 2, delayMs: 1000 });
      previews.set(key, Preview.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))));
    } catch { return null; } // Not cached, so a later request retries.
  }
  return previews.get(key) ?? null;
}

export type Listing = {
  publicationId: string; author: Address; state: number; listingState: number; settlement: number;
  price: string; grossSales: string; pageCount: number; policyId: string;
  title: string; description: string; genre: string; language: string; cover?: string; verified: boolean;
  projectId?: string; createdBlock: string;
};

async function listingFor(id: bigint, createdBlock: bigint, projectIds: Map<string, string>): Promise<Listing> {
  const p = await getPublication(id);
  const meta = await preview(bytes32ToArweaveTxId(p.arweavePreviewTxId), p.previewManifestHash);
  const ref = meta?.previewImages.find(r => /^ar:\/\/[A-Za-z0-9_-]{43}$/.test(r));
  return {
    publicationId: id.toString(), author: getAddress(p.author), state: p.state, listingState: p.listingState, settlement: p.settlementReason,
    price: p.price.toString(), grossSales: p.grossSales.toString(), pageCount: p.pageCount, policyId: p.policyId.toString(),
    title: meta?.title ?? `Publication #${id}`, description: meta?.description ?? "", genre: meta?.genre ?? "", language: meta?.language ?? "",
    cover: ref ? gatewayUrl(ref.slice(5)) : undefined, verified: !!meta,
    projectId: projectIds.get(id.toString()), createdBlock: createdBlock.toString(),
  };
}

export async function listings(): Promise<Listing[]> {
  const { startBlock } = chainConfig();
  const logs = await publicClient().getContractEvents({ ...market(), eventName: "PublicationCreated", fromBlock: startBlock });
  const projectIds = await database(db => new Map(db.projects.filter(p => p.publicationId).map(p => [p.publicationId!, p.id])));
  const all = await Promise.all(logs.map(l => listingFor(l.args.publicationId!, l.blockNumber, projectIds)));
  return all.sort((a, b) => Number(BigInt(b.publicationId) - BigInt(a.publicationId)));
}

const bundles = new Map<string, Uint8Array>();

/** Decrypted pages for the signed-in wallet, if the contract grants it reading access. */
export async function readComic(token: string | undefined, publicationIdRaw: string) {
  ensure(/^\d{1,30}$/.test(publicationIdRaw), "Invalid publication.", 400);
  const publicationId = BigInt(publicationIdRaw);
  const found = await database(db => {
    const user = sessionUser(db, token);
    ensure(user, "Sign in with the wallet that bought this comic.", 401);
    const project = db.projects.find(p => p.publicationId === publicationIdRaw);
    const secrets = project ? db.publicationSecrets?.[project.id] : undefined;
    return { user, projectId: project?.id, wrappedKey: secrets?.wrappedKey };
  });
  ensure(await canRead(publicationId, found.user.address), "This wallet has not bought this comic.", 403);
  ensure(found.projectId && found.wrappedKey, "This server does not hold the key for this publication.", 404);
  const onChain = await getPublication(publicationId);
  const txId = bytes32ToArweaveTxId(onChain.arweaveBundleTxId);
  let bytes = bundles.get(txId);
  if (!bytes) {
    bytes = await fetchVerified(txId, onChain.manifestHash);
    if (bundles.size > 50) bundles.clear();
    bundles.set(txId, bytes);
  }
  const pages = openBundle(bytes, onChain.manifestHash, unwrapKey(found.wrappedKey, found.projectId));
  return { pages: pages.map(p => ({ image: `data:${p.mime};base64,${p.image}`, dialogue: p.dialogue, alt: p.alt })) };
}
