import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, isHex, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppError, database, ensure, sessionUser } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { comicRatingRegistryAbi } from "@/contracts/abi/ComicRatingRegistry";
import { juryModels, runJury } from "@/lib/ai-jury";
import { fetchVerified } from "@/lib/server/arweave";
import { openBundle, unwrapKey } from "@/lib/server/content";

const active = new Set<string>();
export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("projectId");
    ensure(projectId, "Provide a project ID.");
    const result = await database(db => {
      const user = sessionUser(db, req.cookies.get(SESSION_COOKIE)?.value); ensure(user, "Sign in first.", 401);
      const project = db.projects.find(p => p.id === projectId && p.ownerId === user.id); ensure(project, "Project not found.", 404);
      ensure(project.reading?.manifestHash && project.reading.bundleTxId, "Submit the comic for review before accessing its registry hash.", 409);
      return { comicHash: project.reading.manifestHash, arweaveId: project.reading.bundleTxId, revision: project.revision };
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not calculate comic hash." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
export async function POST(req: NextRequest) {
  let lock = ""; let acquired = false; let reserved = false; let broadcasting = false;
  try {
    const body = await req.json() as { projectId?: string; comicId?: string; rubricVersion?: string };
    ensure(typeof body.projectId === "string" && /^\d{1,78}$/.test(body.comicId || "") && /^\d{1,78}$/.test(body.rubricVersion || ""), "Provide a project ID, registered comic ID, and rubric version.");
    const session = req.cookies.get(SESSION_COOKIE)?.value;
    const saved = await database(db => {
      const user = sessionUser(db, session); ensure(user, "Sign in first.", 401);
      const project = db.projects.find(p => p.id === body.projectId && p.ownerId === user.id);
      ensure(project, "Only the project owner can submit a jury rating.", 403);
      ensure(project.reading?.manifestHash && project.reading.bundleTxId, "Submit the comic for review before requesting a jury rating.", 409);
      const secret = db.readingSecrets?.[project.id]; ensure(secret, "The comic content key is unavailable.", 503);
      return structuredClone({ project, secret });
    });
    const { project, secret } = saved;
    const address = process.env.JURY_REGISTRY_ADDRESS?.trim(); const rpc = process.env.JURY_REGISTRY_RPC_URL?.trim();
    const chainId = Number(process.env.JURY_REGISTRY_CHAIN_ID); const key = process.env.JURY_RELAYER_PRIVATE_KEY?.trim();
    const appOrigin = process.env.APP_ORIGIN?.trim();
    ensure(address && isAddress(address) && rpc && Number.isSafeInteger(chainId) && chainId > 0 && key && isHex(key) && key.length === 66 && appOrigin, "Configure the jury registry address, RPC, chain ID, relayer key and APP_ORIGIN.", 503);
    const origin = new URL(appOrigin);
    ensure(!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash && (origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))), "APP_ORIGIN must be a public HTTPS origin or a local development origin.", 503);
    lock = `${chainId}:${address.toLowerCase()}:${body.comicId}:${body.rubricVersion}`;
    ensure(!active.has(lock), "This jury rating is already running.", 409); active.add(lock); acquired = true;
    const chain = defineChain({ id: chainId, name: "Jury registry", nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const transport = http(rpc, { timeout: 15000 });
    const publicClient = createPublicClient({ chain, transport });
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain, transport });
    ensure(await publicClient.getChainId() === chainId, "The registry RPC chain ID does not match its configuration.", 503);
    const contract = { address: getAddress(address), abi: comicRatingRegistryAbi } as const;
    const comicId = BigInt(body.comicId!); const version = BigInt(body.rubricVersion!);
    const [comic, role, minimum] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "getComic", args: [comicId] }),
      publicClient.readContract({ ...contract, functionName: "RELAYER_ROLE" }),
      publicClient.readContract({ ...contract, functionName: "minimumPanelSize" }),
    ]);
    ensure(comic.comicHash.toLowerCase() === project.reading!.manifestHash!.toLowerCase() && comic.arweaveId === project.reading!.bundleTxId, "The registered comic does not match the saved Arweave bundle.", 409);
    ensure(await publicClient.readContract({ ...contract, functionName: "hasRole", args: [role, account.address] }), "The configured jury relayer lacks RELAYER_ROLE.", 503);
    ensure(juryModels().length >= minimum, "The configured jury is smaller than the registry minimum panel size.", 503);
    let exists = true;
    try { await publicClient.readContract({ ...contract, functionName: "getRating", args: [comicId, version] }); }
    catch (error) { if (String(error).includes("RatingNotFound")) exists = false; else throw error; }
    ensure(!exists, "This comic already has a rating for that rubric version.", 409);
    await database(db => {
      db.juryJobs ??= {};
      ensure(!db.juryJobs[lock] || db.juryJobs[lock].status === "failed", "A jury submission is already pending or was submitted. Check the registry before retrying.", 409);
      db.juryJobs[lock] = { status: "pending" };
    }, true);
    reserved = true;
    const bundle = await fetchVerified(project.reading!.bundleTxId!, project.reading!.manifestHash!);
    const jurors = await runJury(openBundle(bundle, project.reading!.manifestHash!, unwrapKey(secret.wrappedKey, project.id)));
    const stillCurrent = await database(db => { const p = db.projects.find(p => p.id === project.id); return !!p && p.revision === project.revision && p.reading?.manifestHash?.toLowerCase() === comic.comicHash.toLowerCase(); });
    ensure(stillCurrent, "The comic changed during jury review. Save and retry.", 409);
    // A relayer signature authenticates the evidence bundle. Router provider checks
    // are gateway-reported; they are not independent juror signatures.
    const statement = { schema: "consentcraft.jury.v1", verification: "gateway-reported", chainId, registry: contract.address, comicHash: comic.comicHash, comicId: comicId.toString(), rubricVersion: version.toString(), jurors };
    const statementHash = keccak256(toBytes(JSON.stringify(statement)));
    const signature = await account.signMessage({ message: { raw: statementHash } });
    const evidence = JSON.stringify({ statement, statementHash, relayer: account.address, signature });
    const evidenceHash = keccak256(toBytes(evidence));
    await database(db => { db.juryEvidence ??= {}; db.juryEvidence[evidenceHash] = evidence; }, true);
    const evidenceURI = `${origin.origin}/api/jury/evidence/${evidenceHash}`;
    const args = [comicId, version, jurors.map(j => j.modelId), jurors.map(j => j.verdict.score), evidenceHash, evidenceURI] as const;
    const simulation = await publicClient.simulateContract({ ...contract, functionName: "postRating", args, account });
    broadcasting = true;
    const hash = await wallet.writeContract(simulation.request);
    await database(db => { db.juryJobs![lock] = { status: "submitted", transactionHash: hash }; }, true);
    // Return the transaction hash immediately: clients must not submit another
    // transaction after a timeout without checking the chain first.
    return NextResponse.json({ transactionHash: hash, evidenceHash, evidenceURI, verification: "gateway-reported", jurors }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (reserved && !broadcasting) await database(db => { if (db.juryJobs?.[lock]) db.juryJobs[lock].status = "failed"; }, true);
    const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
    return NextResponse.json({ error: error instanceof AppError ? error.message : "Jury review failed. Check the server configuration and transaction status before retrying." }, { status, headers: { "Cache-Control": "no-store" } });
  } finally { if (acquired) active.delete(lock); }
}
