import "server-only";
import { getAddress, isAddress, keccak256, parseAbiItem, toHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { database, ensure, event, id, sessionUser, text, type Database } from "@/lib/store";
import type { Project } from "@/lib/types";
import { approvalMessage, readingContributors, readingDomain, readingHashes } from "@/lib/reading-snapshot";
import { readingPermitTypes, teamApprovalTypes } from "@/lib/reading-permit";
import { readingConfig, confirmedReading } from "./reading-chain";
import { buildBundle, newContentKey, previewImage, openBundle, wrapKey, unwrapKey } from "./content";
import { fetchVerified, upload, gatewayUrl } from "./arweave";
import { envValue, privateKey } from "./env";
import { screenWith0G, SCREENING_PROMPT_VERSION } from "./zg";
import { assessOriginality } from "./originality";
import { blankPages } from "./blank-pages";

function member(db: Database, token: string | undefined, raw: unknown, owner = false) {
  const user = sessionUser(db, token); ensure(user, "Sign in with your wallet.", 401);
  const project = db.projects.find(p => p.id === raw && p.members.some(m => m.userId === user.id));
  ensure(project, "Project not found.", 404);
  ensure(!owner || project.ownerId === user.id, "Only the project owner can do this.", 403);
  return { user, project };
}
function snapshotValid(project: Project) {
  const r = project.reading; ensure(r, "Ask the project owner to start team review.", 409);
  const cfg = readingConfig();
  ensure(r.contract.toLowerCase() === cfg.address.toLowerCase() && r.chainId === cfg.chainId, "This review belongs to a different deployment. Reopen the draft for a new review.", 409);
  const hashes = readingHashes(project, r.key);
  ensure(Object.entries(hashes).every(([key, value]) => r[key as keyof typeof hashes] === value), "This comic changed. Reopen it and collect fresh team approvals.", 409);
  return r;
}
async function approved(project: Project, cfg = readingConfig()) {
  const r = snapshotValid(project);
  ensure(r.approvalDeadline > Math.floor(Date.now() / 1000), "Team approvals expired. Reopen the draft for a new review.", 409);
  ensure(r.approvals.length === project.members.length, "Every collaborator, including the owner, must approve this publication first.", 409);
  for (const m of project.members) {
    const a = r.approvals.find(a => a.userId === m.userId && a.address.toLowerCase() === m.address?.toLowerCase());
    ensure(a && await verifyTypedData({ address: getAddress(m.address!), domain: readingDomain(r), types: teamApprovalTypes, primaryType: "TeamApproval", message: approvalMessage(r), signature: a.signature }), "A collaborator's approval is missing or invalid.", 409);
    ensure(!await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "revokedApprovals", args: [a.address, r.key] }), "An approval was withdrawn. Reopen the draft and collect fresh approvals.", 409);
  }
  return r;
}
export async function startTeamReview(token: string | undefined, body: Record<string, unknown>) {
  const cfg = readingConfig();
  return database(db => {
    const { project: p } = member(db, token, body.id, true);
    ensure(p.state === "draft" && !p.reading && !p.publication && !p.edition, "This project already has a publication. Reopen an unminted old submission first.", 409);
    ensure(p.revision === body.revision, "Save your latest changes first.", 409);
    ensure(p.panels.length > 0 && p.panels.every(p => p.image), "Every panel needs saved artwork.");
    text(p.terms, 3000, "Reading license");
    ensure(/^\d{1,78}$/.test(p.priceWei || "") && BigInt(p.priceWei!) > BigInt(0) && BigInt(p.priceWei!) < BigInt(2) ** BigInt(256), "Set and save a positive fixed reading price.");
    ensure(p.members.length <= 64 && p.members[0]?.userId === p.ownerId && p.members.every(m => m.address && isAddress(m.address) && Number.isInteger(m.share) && m.share >= 0 && m.share <= 10000), "Check every collaborator wallet and revenue share.");
    ensure(new Set(p.members.map(m => m.address!.toLowerCase())).size === p.members.length && p.members.reduce((sum, m) => sum + m.share, 0) === 10000, "Each wallet must appear once and revenue shares must total 100%.");
    ensure(!db.invitations.some(i => i.projectId === p.id && !i.accepted && Date.parse(i.expiresAt) > Date.now()), "Accept or cancel pending invitations before starting team review.", 409);
    const key = `0x${id()}` as Hex;
    p.reading = { key, ...readingHashes(p, key), priceWei: p.priceWei!, approvalDeadline: Math.floor(Date.now() / 1000) + 7 * 86400, chainId: cfg.chainId, contract: cfg.address, status: "team-review", approvals: [] };
    p.state = "review"; p.rosterFrozen = true; p.approvals = []; p.revision++;
    event(p, "Started team review of the saved comic, reading price, license and revenue split.");
    return { ok: true };
  }, true);
}
export async function teamApproval(token: string | undefined, body: Record<string, unknown>, save = false) {
  const snapshot = await database(db => structuredClone(member(db, token, body.id)));
  const r = snapshotValid(snapshot.project);
  ensure(r.status === "team-review", "This version is already in curator review or published.", 409);
  ensure(r.approvalDeadline > Math.floor(Date.now() / 1000), "Review expired. Reopen the draft.", 409);
  const cfg = readingConfig();
  ensure(!await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "revokedApprovals", args: [snapshot.user.address, r.key] }), "You withdrew approval of this version. Ask the owner to reopen it.", 409);
  const payload = { domain: readingDomain(r), types: teamApprovalTypes, primaryType: "TeamApproval" as const, message: approvalMessage(r) };
  if (!save) return payload;
  ensure(body.rights === true, "Confirm your permission to publish this exact comic, price and license.");
  ensure(typeof body.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(body.signature), "A wallet approval signature is required.");
  ensure(await verifyTypedData({ ...payload, address: snapshot.user.address, signature: body.signature as Hex }), "The approval signature does not match your wallet or this version.", 401);
  await database(db => {
    const { user, project } = member(db, token, body.id); const current = snapshotValid(project);
    ensure(current.key === r.key && current.status === "team-review", "The review changed. Reload before approving.", 409);
    current.approvals = current.approvals.filter(a => a.userId !== user.id);
    current.approvals.push({ userId: user.id, address: user.address, signature: body.signature as Hex, at: new Date().toISOString() });
    project.approvals = current.approvals.map(a => a.userId); event(project, `${user.name} approved this publication and its fixed reading price.`);
  }, true);
  return { ok: true };
}
export async function withdrawTeamApproval(token: string | undefined, raw: unknown) {
  const snapshot = await database(db => structuredClone(member(db, token, raw))); const r = snapshotValid(snapshot.project);
  ensure(r.status !== "published", "Published approvals are part of the publication record.", 409);
  const cfg = await confirmedReading();
  ensure(await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, blockNumber: cfg.blockNumber, functionName: "revokedApprovals", args: [snapshot.user.address, r.key] }), "Confirm withdrawal in your wallet and wait for confirmations first.", 409);
  await database(db => {
    const { user, project } = member(db, token, raw);
    ensure(project.reading?.key === r.key && project.reading.status !== "published", "Review changed.", 409);
    project.reading.approvals = project.reading.approvals.filter(a => a.userId !== user.id); project.approvals = project.reading.approvals.map(a => a.userId);
    event(project, `${user.name} withdrew publication approval. A fresh team review is required.`);
  }, true);
  return { ok: true };
}
export async function reopenReading(token: string | undefined, raw: unknown) {
  const cfg = readingConfig(); const p = await database(db => structuredClone(member(db, token, raw, true).project));
  const r = p.reading; ensure(r && r.status !== "published", "This publication cannot be reopened.", 409);
  const [published, block] = await Promise.all([cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "comicForKey", args: [r.key] }), cfg.client.getBlock()]);
  ensure(published === BigInt(0), "Publication is on chain; recover its confirmation instead.", 409);
  ensure(Number(block.timestamp) > (r.permitExpiresAt || 0), "A publication permit is still valid. Wait until it expires before reopening; withdrawing approval on chain prevents publication meanwhile.", 409);
  await database(db => {
    const { project } = member(db, token, raw, true);
    ensure(project.reading?.key === r.key && !((db.readingJobs?.[project.id]?.expires || 0) > Date.now()), "Curator review is running. Retry shortly.", 409);
    ensure(project.reading.status !== "published" && Number(block.timestamp) > (project.reading.permitExpiresAt || 0), "A publication permit was issued while reopening. Wait for its expiry and retry.", 409);
    delete project.reading; if (db.readingSecrets) delete db.readingSecrets[project.id];
    project.state = "draft"; project.rosterFrozen = false; project.approvals = []; project.revision++;
    event(project, "Reopened the draft. All publication approvals were reset.");
  }, true);
  return { ok: true };
}

export async function curateReading(token: string | undefined, raw: unknown) {
  const cfg = readingConfig(); const job = id(); const projectId = text(raw, 100, "Project");
  let snapshot = await database(async db => {
    const { project } = member(db, token, projectId, true); const r = await approved(project, cfg);
    ensure(r.status !== "published", "This comic is already published.", 409);
    db.readingJobs ??= {}; ensure(!db.readingJobs[projectId] || db.readingJobs[projectId].expires <= Date.now(), "Curator review is already running. Refresh shortly.", 409);
    if (!r.bundleTxId) {
      db.editionSubmissions = (db.editionSubmissions || []).filter(s => s.at > Date.now() - 86400000);
      if (!db.editionSubmissions.some(s => s.readingKey === r.key)) {
        ensure(db.editionSubmissions.filter(s => s.userId === project.ownerId).length < 5, "The pilot allows five new submissions per wallet account per day.", 429);
        db.editionSubmissions.push({ userId: project.ownerId, at: Date.now(), readingKey: r.key });
      }
    }
    db.readingJobs[projectId] = { id: job, expires: Date.now() + 5 * 60_000 };
    return structuredClone(project);
  }, true);
  const active = (db: Database) => {
    const p = member(db, token, projectId, true).project;
    ensure(p.reading?.key === snapshot.reading!.key && db.readingJobs?.[projectId]?.id === job, "Review changed. Reload the project.", 409);
    return p;
  };
  try {
    const blank = await blankPages(snapshot.panels);
    ensure(blank.length === 0, `Page${blank.length === 1 ? "" : "s"} ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} blank or a single colour. Add artwork before publishing.`, 409);
    const originality = await assessOriginality(snapshot.panels, "reading");
    await database(db => { active(db).originality = originality; }, true);
    ensure(originality.maxSimilarity <= 85, "This comic is more than 85% similar to a published comic. Publication is blocked; see the comparison below.", 409);
    const latest = await confirmedReading();
    const count = await latest.client.readContract({ address: latest.address, abi: latest.abi, blockNumber: latest.blockNumber, functionName: "comicCount" });
    ensure(count.toString() === originality.comparedComicCount, "The published catalogue changed during review. Retry.", 409);
    if (!snapshot.reading!.bundleTxId) {
      const key = newContentKey(); const bundle = buildBundle(snapshot.panels, key); const cover = await previewImage(snapshot.panels);
      const tags = [{ name: "App-Name", value: "ConsentCraft" }, { name: "Type", value: "fixed-price-reading" }];
      const [bundleTxId, coverTxId] = await Promise.all([upload(bundle.bytes, "application/json", tags), upload(cover, "image/jpeg", tags)]);
      snapshot = await database(db => {
        const p = active(db); p.reading = { ...p.reading!, bundleTxId, coverTxId, manifestHash: bundle.manifestHash, status: "uploaded" };
        db.readingSecrets ??= {}; db.readingSecrets[projectId] = { wrappedKey: wrapKey(key, projectId) };
        return structuredClone(p);
      }, true);
    }
    const r = snapshot.reading!;
    if (!r.review) {
      const wrapped = await database(db => db.readingSecrets?.[projectId]); ensure(wrapped, "Content key unavailable.", 503);
      const bytes = await fetchVerified(r.bundleTxId!, r.manifestHash!);
      const result = await screenWith0G(openBundle(bytes, r.manifestHash!, unwrapKey(wrapped.wrappedKey, projectId)), { usePrivateComputer: true });
      await database(db => {
        const p = active(db); ensure(p.reading!.approvals.length === p.members.length, "A team approval was withdrawn.", 409);
        p.reading!.review = { score: result.score, flagged: result.flagged, reasons: result.reasons, model: result.model, provider: result.provider, teeVerified: result.teeVerified, at: result.at, promptVersion: SCREENING_PROMPT_VERSION, assessment: result.assessment, requestId: result.chatId, verification: result.verification, evidence: result.evidence, uncertainty: "AI findings are advisory and do not prove authorship or copyright. Provider checks are gateway-reported." };
        p.reading!.status = result.flagged ? "flagged" : "approved"; delete p.reading!.error;
        event(p, result.flagged ? "Curator review requires a human review before publication." : "Curator review completed. All team approvals remain required for publication.");
      }, true);
    }
    const final = await database(db => structuredClone(active(db))); await approved(final, cfg);
    ensure(final.reading!.status === "approved", "Curator review flagged this comic. Reopen it for corrections and new team approvals.", 409);
    return { reviewReady: true };
  } catch (error) {
    await database(db => { const p = db.projects.find(p => p.id === projectId); if (p && p.reading?.key === snapshot.reading?.key) p.reading!.error = error instanceof Error ? error.message.slice(0, 300) : "Review failed."; }, true);
    throw error;
  } finally { await database(db => { if (db.readingJobs?.[projectId]?.id === job) delete db.readingJobs[projectId]; }, true); }
}
export async function prepareReading(token: string | undefined, raw: unknown) {
  const cfg = readingConfig(); const p = await database(db => structuredClone(member(db, token, raw, true).project));
  const r = await approved(p, cfg); ensure(r.status === "approved" && r.review && !r.review.flagged, "Complete curator review first.", 409);
  const latest = await confirmedReading();
  const count = await latest.client.readContract({ address: latest.address, abi: latest.abi, blockNumber: latest.blockNumber, functionName: "comicCount" });
  ensure(p.originality && p.originality.maxSimilarity <= 85 && p.originality.comparedComicCount === count.toString(), "Published comics changed since originality review. Retry review.", 409);
  let uri = r.uri, metadataHash = r.metadataHash;
  if (!uri) {
    const metadata = { schema: "consentcraft.reading.v1", name: p.title, description: p.description, genre: p.genre, image: `ar://${r.coverTxId}`, license: p.terms, priceWei: r.priceWei, contributors: p.members.map(m => ({ address: m.address, name: m.name, role: m.role, share: m.share })), manifestHash: r.manifestHash, contentHash: r.contentHash, review: r.review, originality: p.originality, access: "Fixed-price, non-transferable reading access. Multiple readers can purchase the same comic. Copyright remains with the creators." };
    const bytes = new TextEncoder().encode(JSON.stringify(metadata)); metadataHash = keccak256(bytes);
    uri = `ar://${await upload(bytes, "application/json", [{ name: "App-Name", value: "ConsentCraft" }])}`;
    await database(db => { const current = member(db, token, raw, true).project; ensure(current.reading?.key === r.key, "Review changed.", 409); current.reading.uri = uri; current.reading.metadataHash = metadataHash; }, true);
  }
  await fetchVerified(uri.slice(5), metadataHash!);
  const signer = privateKeyToAccount(privateKey("EDITION_REVIEWER_PRIVATE_KEY", "Reading publication reviewer"));
  ensure(getAddress(await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "reviewer" })) === signer.address, "Reviewer key does not match the reading contract.", 503);
  const chainTime = Number((await cfg.client.getBlock()).timestamp); const deadline = BigInt(Math.max(chainTime, Math.floor(Date.now() / 1000)) + 600);
  const permit = { author: getAddress(p.members[0].address!), key: r.key, contentHash: r.contentHash, manifestHash: r.manifestHash!, metadataHash: metadataHash!, uriHash: keccak256(toHex(uri)), licenseHash: r.licenseHash, contributorsHash: r.contributorsHash, price: BigInt(r.priceWei), approvalDeadline: BigInt(r.approvalDeadline), deadline };
  // Revalidate and reserve expiry atomically after external I/O. Reopening must
  // wait out every issued permit, including one issued by another instance.
  await database(async db => { const current = member(db, token, raw, true).project; const stored = await approved(current, cfg); ensure(stored.key === r.key && stored.status === "approved", "Review changed.", 409); stored.permitExpiresAt = Math.max(stored.permitExpiresAt || 0, Number(deadline)); }, true);
  const signature = await signer.signTypedData({ domain: readingDomain(r), types: readingPermitTypes, primaryType: "Permit", message: permit });
  return { permit, uri, team: { ...readingContributors(p), approvals: p.members.map(m => r.approvals.find(a => a.userId === m.userId)!.signature) }, signature };
}
export async function confirmReading(token: string | undefined, raw: unknown) {
  const cfg = await confirmedReading(); const snapshot = await database(db => structuredClone(member(db, token, raw, true).project));
  const r = snapshotValid(snapshot); const comicId = await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, blockNumber: cfg.blockNumber, functionName: "comicForKey", args: [r.key] });
  ensure(comicId > BigInt(0), "Publication is not confirmed yet. Retry shortly.", 409);
  const c = await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, blockNumber: cfg.blockNumber, functionName: "comics", args: [comicId] });
  ensure(c[2] === r.contentHash && c[3] === r.manifestHash && c[7] === BigInt(r.priceWei), "Publication does not match the approved comic.", 409);
  await database(db => { const p = member(db, token, raw, true).project; ensure(p.reading?.key === r.key, "Review changed.", 409); if (p.reading.status === "published") return; p.reading.status = "published"; p.reading.comicId = comicId.toString(); p.state = "published"; p.publishedAt = new Date().toISOString(); p.version++; event(p, "Published at the fixed reading price after unanimous collaborator approval."); }, true);
  return { comicId: comicId.toString() };
}
export async function readComic(token: string | undefined, raw: string) {
  ensure(/^[1-9]\d{0,29}$/.test(raw), "Invalid comic."); const cfg = await confirmedReading(); const comicId = BigInt(raw);
  const user = await database(db => sessionUser(db, token)); ensure(user, "Sign in with the wallet that purchased reading access.", 401);
  const access = () => cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "canRead", args: [comicId, user.address], blockNumber: cfg.blockNumber });
  ensure(await access(), "Purchase reading access to read this comic.", 403);
  const comic = await cfg.client.readContract({ address: cfg.address, abi: cfg.abi, functionName: "comics", args: [comicId], blockNumber: cfg.blockNumber });
  const record = await database(db => { const p = db.projects.find(p => p.reading?.key === comic[1] && p.reading.contract.toLowerCase() === cfg.address.toLowerCase()); return p && db.readingSecrets?.[p.id] ? { id: p.id, reading: p.reading!, secret: db.readingSecrets[p.id] } : undefined; });
  ensure(record, "The encrypted content key is unavailable. Contact the studio operator.", 503);
  const pages = openBundle(await fetchVerified(record.reading.bundleTxId!, comic[3]), comic[3], unwrapKey(record.secret.wrappedKey, record.id));
  ensure(await access(), "Reading access could not be confirmed.", 403);
  return { pages };
}

export async function readingSnapshot(wallet?: `0x${string}`, page = 0, rawId?: string, library = false, creditsOnly = false) {
  const cfg = await confirmedReading(); const base = { address: cfg.address, abi: cfg.abi, blockNumber: cfg.blockNumber };
  const [count, credit] = await Promise.all([cfg.client.readContract({ ...base, functionName: "comicCount" }), wallet ? cfg.client.readContract({ ...base, functionName: "credits", args: [wallet] }) : BigInt(0)]);
  if (rawId) ensure(/^[1-9]\d{0,29}$/.test(rawId) && BigInt(rawId) <= count, "Comic not found.", 404);
  if (creditsOnly) return { comics: [], total: "0", credit: credit.toString(), page, confirmations: cfg.confirmations };
  let total = count;
  let ids = rawId ? [BigInt(rawId)] : Array.from({ length: Math.max(0, Math.min(12, Number(count) - page * 12)) }, (_, i) => count - BigInt(page * 12 + i));
  if (library && wallet && !rawId) {
    const start = BigInt(envValue("READING_START_BLOCK") || "0");
    ensure(cfg.chainId === 31337 || start > BigInt(0) || count === BigInt(0), "The reading library's deployment block is not configured.", 503);
    const owned = new Set<string>();
    if (count > BigInt(0)) for (let fromBlock = start; fromBlock <= cfg.blockNumber; fromBlock += BigInt(1000)) {
      const end = fromBlock + BigInt(999);
      const logs = await cfg.client.getLogs({ address: cfg.address, event: parseAbiItem("event ReadingPurchased(uint256 indexed comicId, address indexed reader, uint256 price)"), args: { reader: wallet }, fromBlock, toBlock: end < cfg.blockNumber ? end : cfg.blockNumber });
      for (const log of logs) if (log.args.comicId) owned.add(log.args.comicId.toString());
      const inherited = await cfg.client.getLogs({ address: cfg.address, event: parseAbiItem("event ReadingInherited(uint256 indexed comicId, address indexed from, address indexed heir)"), args: { heir: wallet }, fromBlock, toBlock: end < cfg.blockNumber ? end : cfg.blockNumber });
      for (const log of inherited) if (log.args.comicId) owned.add(log.args.comicId.toString());
    }
    const contributions = await database(db => db.projects.filter(p => p.reading?.status === "published" && p.reading.chainId === cfg.chainId && p.reading.contract.toLowerCase() === cfg.address.toLowerCase() && p.members.some(m => m.address?.toLowerCase() === wallet.toLowerCase())).map(p => p.reading!.comicId!));
    for (const comic of contributions) if (BigInt(comic) <= count) owned.add(comic);
    const all = [...owned].map(BigInt).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    total = BigInt(all.length); ids = all.slice(page * 12, page * 12 + 12);
  }
  const comics = await Promise.all(ids.map(async id => {
    const [c, delisted, canRead, team] = await Promise.all([cfg.client.readContract({ ...base, functionName: "comics", args: [id] }), cfg.client.readContract({ ...base, functionName: "delisted", args: [id] }), wallet ? cfg.client.readContract({ ...base, functionName: "canRead", args: [id, wallet] }) : false, cfg.client.readContract({ ...base, functionName: "getContributors", args: [id] })]);
    let metadata: { name?: string; description?: string; genre?: string; license?: string; image?: string; contributors?: unknown[]; originality?: Project["originality"] } = {};
    if (/^ar:\/\/[a-zA-Z0-9_-]{43}$/.test(c[8])) try { metadata = JSON.parse(Buffer.from(await fetchVerified(c[8].slice(5), c[4], { attempts: 1 })).toString("utf8")); } catch {}
    return { id: id.toString(), author: c[0], priceWei: c[7].toString(), readers: c[9].toString(), uri: c[8], manifestHash: c[3], delisted, canRead, title: metadata.name || `Comic #${id}`, description: metadata.description || "", genre: metadata.genre || "", license: metadata.license || "", originality: metadata.originality, cover: /^ar:\/\/[a-zA-Z0-9_-]{43}$/.test(metadata.image || "") ? gatewayUrl(metadata.image!.slice(5)) : undefined, contributors: team[0].map((address, i) => ({ address, share: team[1][i] })) };
  }));
  return { comics, total: total.toString(), credit: credit.toString(), page, confirmations: cfg.confirmations };
}
