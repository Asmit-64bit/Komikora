import "server-only";
import { encodeAbiParameters, getAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { database, ensure, event, sessionUser, text, type Database } from "@/lib/store";
import type { EditionPublication, Project, User } from "@/lib/types";
import { editionPermitTypes } from "@/lib/edition-permit";
import { buildBundle, newContentKey, previewImage, openBundle, wrapKey, unwrapKey } from "./content";
import { fetchVerified, upload, gatewayUrl } from "./arweave";
import { screenWith0G, SCREENING_PROMPT_VERSION } from "./zg";
import { privateKey } from "./env";
import { confirmedNFT, nftConfig } from "./nft-chain";
import { assessOriginality } from "./originality";
import { blankPages } from "./blank-pages";

function owner(db: Database, token: string | undefined, id: unknown) {
  const user = sessionUser(db, token); ensure(user, "Sign in with your wallet.", 401);
  const project = db.projects.find(p => p.id === id && p.ownerId === user.id); ensure(project, "Project not found.", 404);
  return { user, project };
}
const running = new Set<string>();
const LIMIT = 5;

export async function prepareEdition(token: string | undefined, body: Record<string, unknown>) {
  const cfg = nftConfig();
  const projectId = text(body.id, 100, "Project");
  ensure(!running.has(projectId), "This publication is already being processed. Refresh shortly.", 409);
  running.add(projectId);
  let authorized = false;
  try {
    let snapshot = await database(db => {
      const { user, project } = owner(db, token, projectId);
      ensure(!project.publication, "This project uses the legacy publishing flow. Create a new project for NFT editions.", 409);
      ensure(project.edition?.status !== "minted", "These editions are already minted.", 409);
      if (!project.edition) {
        ensure(project.state === "draft" && project.revision === body.revision, "Save your latest changes first.", 409);
        ensure(body.rights === true, "Confirm you have permission from all rights holders.");
        const recent = (db.editionSubmissions || []).filter(p => p.userId === user.id && p.at > Date.now() - 86400000);
        ensure(recent.length < LIMIT, "The pilot allows five submissions per wallet account per day.", 429);
        ensure(Number.isInteger(body.supply) && Number(body.supply) >= 1 && Number(body.supply) <= 25, "Choose 1–25 editions.");
        const reserve = String(body.reserveWei || "10000000000000000");
        ensure(/^\d{1,78}$/.test(reserve) && BigInt(reserve) > BigInt(0) && BigInt(reserve) < BigInt(2) ** BigInt(256), "Choose a positive auction reserve.");
        const duration = Number(body.auctionDuration || 86400);
        ensure(Number.isInteger(duration) && duration >= 3600 && duration <= 2592000, "Auction duration must be 1 hour–30 days.");
        ensure(project.panels.every(p => p.image), "Every panel needs artwork.");
        text(project.terms, 3000, "License");
      }
      return structuredClone(project);
    });
    authorized = true;
    const blank = await blankPages(snapshot.panels);
    ensure(blank.length === 0, `Page${blank.length === 1 ? "" : "s"} ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} blank or a single colour. Add artwork before publishing.`, 409);
    // Recheck the confirmed catalogue on every submission or permit request, including
    // drafts uploaded before originality review was introduced.
    const originality = await assessOriginality(snapshot.panels);
    await database(db => {
      const { project } = owner(db, token, projectId);
      ensure(project.revision === snapshot.revision, "Project changed during originality review. Save and retry.", 409);
      project.originality = originality;
    }, true);
    ensure(originality.maxSimilarity <= 85, "This comic is more than 85% similar to a published comic. NFT publication is blocked; see the comparison below.", 409);
    const latest = await confirmedNFT();
    const currentCount = await latest.client.readContract({ address: latest.address, abi: latest.abi, blockNumber: latest.blockNumber, functionName: "comicCount" });
    ensure(currentCount.toString() === originality.comparedComicCount, "The published catalogue changed during review. Retry.", 409);
    if (!snapshot.edition) {
      const key = newContentKey(); const bundle = buildBundle(snapshot.panels, key);
      const cover = await previewImage(snapshot.panels);
      const tags = [{ name: "App-Name", value: "ConsentCraft" }];
      const [bundleTxId, coverTxId] = await Promise.all([upload(bundle.bytes, "application/json", tags), upload(cover, "image/jpeg", tags)]);
      const edition: EditionPublication = { key: keccak256(toHex(`${cfg.chainId}:${cfg.address}:${projectId}:${bundle.manifestHash}`)), manifestHash: bundle.manifestHash, bundleTxId, coverTxId, supply: Number(body.supply), license: snapshot.terms, rightsAt: new Date().toISOString(), status: "uploaded", chainId: cfg.chainId, contract: cfg.address, reserveWei: String(body.reserveWei || "10000000000000000"), auctionDuration: Number(body.auctionDuration || 86400) };
      snapshot = await database(db => {
        const { project } = owner(db, token, projectId);
        ensure(!project.edition && project.revision === snapshot.revision, "Project changed during upload. Refresh and retry.", 409);
        db.editionSubmissions = (db.editionSubmissions || []).filter(p => p.at > Date.now() - 86400000);
        ensure(db.editionSubmissions.filter(p => p.userId === project.ownerId).length < LIMIT, "Daily submission limit reached.", 429);
        db.editionSubmissions.push({ userId: project.ownerId, at: Date.now() });
        project.edition = edition; project.state = "review"; project.rosterFrozen = true; project.revision++;
        db.editionSecrets ??= {}; db.editionSecrets[projectId] = { wrappedKey: wrapKey(key, projectId) };
        event(project, "Submitted NFT editions with a rights declaration."); return structuredClone(project);
      }, true);
    }
    const ed = snapshot.edition!;
    ensure(ed.chainId === cfg.chainId && ed.contract.toLowerCase() === cfg.address.toLowerCase(), "Publication belongs to another deployment.", 409);
    await fetchVerified(ed.bundleTxId, ed.manifestHash);
    if (!ed.review) {
      const secret = await database(db => db.editionSecrets?.[projectId]); ensure(secret, "Content key unavailable.", 503);
      const bytes = await fetchVerified(ed.bundleTxId, ed.manifestHash);
      const result = await screenWith0G(openBundle(bytes, ed.manifestHash, unwrapKey(secret.wrappedKey, projectId)), { usePrivateComputer: true });
      await database(db => {
        const { project } = owner(db, token, projectId);
        project.edition!.review = { score: result.score, flagged: result.flagged, reasons: result.reasons, model: result.model, provider: result.provider, teeVerified: result.teeVerified, at: result.at, promptVersion: SCREENING_PROMPT_VERSION, assessment: result.assessment, requestId: result.chatId, verification: result.verification, evidence: result.evidence, uncertainty: "AI findings can be wrong. They do not prove authorship, copyright, or artistic merit. Private-compute checks are reported by the 0G gateway; this app does not independently verify its hardware quote. Attestation does not guarantee score accuracy." };
        project.edition!.status = result.flagged ? "flagged" : "approved";
        project.edition!.error = undefined;
      }, true);
    }
    snapshot = await database(db => structuredClone(owner(db, token, projectId).project));
    ensure(snapshot.edition!.status === "approved", "This submission needs human review. Submit an appeal below.", 409);
    if (body.reviewOnly === true) return { reviewReady: true };
    return await permitFor(snapshot, cfg, token);
  } catch (error) {
    if (authorized) await database(db => { const p = db.projects.find(p => p.id === projectId); if (p?.edition && p.edition.status !== "minted") p.edition.error = (error as Error).message.slice(0, 300); }, true);
    throw error;
  } finally { running.delete(projectId); }
}

async function permitFor(project: Project, cfg: ReturnType<typeof nftConfig>, token?: string) {
  const e = project.edition!;
  const latest = await confirmedNFT();
  const currentCount = await latest.client.readContract({ address: latest.address, abi: latest.abi, blockNumber: latest.blockNumber, functionName: "comicCount" });
  ensure(project.originality && project.originality.maxSimilarity <= 85 && project.originality.comparedComicCount === currentCount.toString(), "Published comics changed since the originality check. Retry review.", 409);
  const blockTime = (await cfg.client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = (blockTime > now ? blockTime : now) + BigInt(10 * 60);
  if (!e.uri) {
    const metadata = { name: project.title, description: project.description, image: `ar://${e.coverTxId}`, genre: project.genre, creator: project.members[0].address, editionSupply: e.supply, license: e.license, firstAuction: { reserveWei: e.reserveWei || "10000000000000000", duration: e.auctionDuration || 86400 }, copyright: "Copyright remains with the creators. Reading license follows current ownership.", manifestHash: e.manifestHash, review: e.review, originality: project.originality, reviewOverride: e.appeal?.decision === "approved" ? { decision: "approved", reason: e.appeal.reason, reviewer: e.appeal.reviewer } : undefined };
    const bytes = new TextEncoder().encode(JSON.stringify(metadata));
    const tx = await upload(bytes, "application/json", [{ name: "App-Name", value: "ConsentCraft" }, { name: "Type", value: "nft-metadata" }]);
    e.uri = `ar://${tx}`; e.metadataHash = keccak256(bytes);
    await database(db => { db.projects.find(p => p.id === project.id)!.edition = e; }, true);
  }
  await fetchVerified(e.uri.slice(5), e.metadataHash!);
  const signer = privateKeyToAccount(privateKey("EDITION_REVIEWER_PRIVATE_KEY", "NFT approval"));
  const reviewer = await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "reviewer" });
  ensure(getAddress(reviewer) === getAddress(signer.address), "NFT reviewer key does not match the contract.", 503);
  const auctionHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [BigInt(e.reserveWei || "10000000000000000"), BigInt(e.auctionDuration || 86400)]));
  const permit = { author: getAddress(project.members[0].address!), key: e.key, manifestHash: e.manifestHash, metadataHash: e.metadataHash!, uriHash: keccak256(toHex(e.uri)), licenseHash: keccak256(toHex(e.license)), auctionHash, supply: e.supply, deadline };
  // Reserve the expiry before signing so reopening cannot race a live permit.
  await database(db => {
    const stored = owner(db, token, project.id).project.edition;
    ensure(stored?.status === "approved" && stored.key === e.key && stored.manifestHash === e.manifestHash, "Publication changed. Refresh and retry.", 409);
    stored.permitExpiresAt = Math.max(stored.permitExpiresAt || 0, Number(deadline));
  }, true);
  const signature = await signer.signTypedData({ domain: { name: "ConsentCraftEditions", version: "1", chainId: cfg.chainId, verifyingContract: cfg.address }, types: editionPermitTypes, primaryType: "Permit", message: permit });
  return { permit: { ...permit, deadline: permit.deadline.toString() }, uri: e.uri, signature };
}

export async function reopenEdition(token: string | undefined, id: unknown) {
  const cfg = nftConfig(); const p = await database(db => structuredClone(owner(db, token, id).project));
  ensure(p.edition && p.edition.status !== "minted", "This publication cannot be reopened.", 409);
  const [minted, block] = await Promise.all([cfg.client.readContract({ ...cfg, functionName: "comicForKey", args: [p.edition.key] }), cfg.client.getBlock()]);
  ensure(minted === BigInt(0), "Editions already exist; recover the mint instead.", 409);
  ensure(Number(block.timestamp) > (p.edition.permitExpiresAt || 0), "A mint permit is still valid. Wait until it expires before reopening.", 409);
  ensure(!running.has(p.id), "Review is still running.", 409);
  await database(db => { const { project } = owner(db, token, id); delete project.edition; if (db.editionSecrets) delete db.editionSecrets[project.id]; project.state = "draft"; project.revision++; event(project, "Reopened unminted work for corrections."); }, true);
  return { ok: true };
}

export async function confirmEdition(token: string | undefined, id: unknown) {
  const cfg = await confirmedNFT();
  const snapshot = await database(db => structuredClone(owner(db, token, id).project));
  ensure(snapshot.edition, "Prepare the editions first.");
  const comicId = await cfg.client.readContract({ ...cfg, functionName: "comicForKey", args: [snapshot.edition.key] });
  ensure(comicId > BigInt(0), "Mint transaction is not confirmed yet. Try again shortly.", 409);
  const comic = await cfg.client.readContract({ ...cfg, functionName: "comics", args: [comicId] });
  ensure(comic[2] === snapshot.edition.manifestHash, "Comic fingerprint mismatch.", 409);
  await database(db => { const { project } = owner(db, token, id); project.edition!.comicId = comicId.toString(); project.edition!.status = "minted"; project.state = "published"; project.publishedAt = new Date().toISOString(); event(project, "Minted fixed supply NFT editions."); }, true);
  return { comicId: comicId.toString() };
}

export async function readEdition(token: string | undefined, raw: string) {
  ensure(/^\d{1,30}$/.test(raw), "Invalid edition.");
  const cfg = await confirmedNFT(); const tokenId = BigInt(raw);
  const user = await database(db => sessionUser(db, token)); ensure(user, "Sign in with the owner wallet.", 401);
  ensure(await cfg.client.readContract({ ...cfg, functionName: "canRead", args: [tokenId, user.address] }), "Only the current edition owner can read this comic.", 403);
  const comicId = await cfg.client.readContract({ ...cfg, functionName: "tokenComic", args: [tokenId] });
  const comic = await cfg.client.readContract({ ...cfg, functionName: "comics", args: [comicId] });
  const record = await database(db => { const p = db.projects.find(p => p.edition?.key === comic[1]); return p && db.editionSecrets?.[p.id] ? { id: p.id, edition: p.edition!, secret: db.editionSecrets[p.id] } : undefined; });
  ensure(record, "This server does not hold the content key. Contact support.", 503);
  const bytes = await fetchVerified(record.edition.bundleTxId, comic[2]);
  const pages = openBundle(bytes, comic[2], unwrapKey(record.secret.wrappedKey, record.id));
  // Check again after slow storage/decryption work. No decrypted response is cached.
  const current = await confirmedNFT();
  ensure(await current.client.readContract({ ...current, functionName: "canRead", args: [tokenId, user.address] }), "Ownership changed. Reading access ended.", 403);
  return { pages: pages.map(p => ({ image: `data:${p.mime};base64,${p.image}`, dialogue: p.dialogue, alt: p.alt })), checkedBlock: current.blockNumber.toString(), accessSeconds: 15 };
}

export async function nftMetadata(uri: string, hash: Hex) {
  ensure(/^ar:\/\/[a-zA-Z0-9_-]{43}$/.test(uri), "Unsupported metadata reference.");
  const bytes = await fetchVerified(uri.slice(5), hash, { attempts: 1, delayMs: 0 });
  const m = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return { title: String(m.name).slice(0, 100), description: String(m.description || "").slice(0, 1000), genre: String(m.genre || ""), license: String(m.license || ""), cover: /^ar:\/\/[\w-]{43}$/.test(m.image) ? gatewayUrl(m.image.slice(5)) : undefined, review: m.review, originality: m.originality, reviewOverride: m.reviewOverride, firstAuction: m.firstAuction };
}
export async function editionAppeal(token: string | undefined, body: Record<string, unknown>) {
  const cfg = nftConfig();
  const user = await database(db => sessionUser(db, token)); ensure(user, "Sign in first.", 401);
  const reviewer = await cfg.client.readContract({ ...cfg, functionName: "reviewer" });
  if (body.action === "resolve") ensure(user.address.toLowerCase() === reviewer.toLowerCase(), "Only the designated reviewer can decide appeals.", 403);
  await database(db => {
    const p = db.projects.find(p => p.id === body.id); ensure(p?.edition, "Submission not found.", 404);
    const e = p.edition;
    if (body.action === "appeal") {
      ensure(p.ownerId === user.id && e.status === "flagged" && !e.appeal, "This submission cannot be appealed.", 409);
      e.appeal = { text: text(body.text, 4000, "Appeal"), at: new Date().toISOString(), deadline: new Date(Date.now() + 72 * 3600000).toISOString() };
    } else {
      ensure(body.action === "resolve" && e.appeal && !e.appeal.decision, "No pending appeal.", 409);
      e.appeal.decision = body.approved === true ? "approved" : "rejected";
      e.appeal.reason = text(body.text, 2000, "Decision reason"); e.appeal.reviewer = user.address;
      e.status = body.approved === true ? "approved" : "flagged"; e.error = undefined;
    }
  }, true);
  return { ok: true };
}
export async function moderationQueue(user: User) {
  const cfg = nftConfig(); const reviewer = await cfg.client.readContract({ ...cfg, functionName: "reviewer" });
  ensure(user.address.toLowerCase() === reviewer.toLowerCase(), "Reviewer access required.", 403);
  return database(db => ({ appeals: db.projects.filter(p => p.edition?.appeal && !p.edition.appeal.decision).map(p => ({ id: p.id, title: p.title, appeal: p.edition!.appeal, review: p.edition!.review })), reports: db.abuseReports || [] }));
}
