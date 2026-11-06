import "server-only";
// Author publishing: encrypt, upload to Arweave, verify, then sign a quote the
// author's own wallet submits to createPublication. The server never moves funds.
import { getAddress, keccak256, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arweaveTxIdToBytes32 } from "@/contracts/lib/arweave-tx-id";
import { PersonhoodAction, randomNonce, signPersonhoodCertificate, signPublicationQuote, type PublicationQuote } from "@/lib/eip712";
import { AppError, database, ensure, event, sessionUser, text, type Database } from "@/lib/store";
import type { PublicationView, User } from "@/lib/types";
import { fetchVerified, upload } from "./arweave";
import { confirmedMarketEvents, getPolicy, getPublication, publicationsCreatedBy } from "./chain";
import { buildBundle, newContentKey, previewImage, previewManifest, wrapKey } from "./content";
import { chainConfig, privateKey, publishingTerms } from "./env";
import { scheduleReview } from "./review";

const QUOTE_TTL_SECONDS = 15 * 60;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

function ownedProject(db: Database, user: User, projectId: unknown) {
  const project = db.projects.find(p => p.id === projectId);
  ensure(project && project.members.some(m => m.userId === user.id), "Project not found.", 404);
  ensure(project.ownerId === user.id, "Only the project owner can publish.", 403);
  return project;
}

function quoteSigner() {
  return privateKeyToAccount(privateKey("QUOTE_SIGNER_PRIVATE_KEY", "Publication quotes"));
}

/** Signs a fresh quote and PUBLISH certificate for an already-uploaded publication. */
async function signQuote(view: PublicationView, author: Address) {
  const { chainId, market } = chainConfig();
  const signer = quoteSigner();
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS);
  const quote: PublicationQuote = {
    author,
    manifestHash: view.manifestHash, previewManifestHash: view.previewManifestHash,
    arweaveBundleTxId: arweaveTxIdToBytes32(view.bundleTxId), arweavePreviewTxId: arweaveTxIdToBytes32(view.previewTxId),
    pageCount: view.pageCount, policyId: BigInt(view.policyId), price: BigInt(view.priceWei),
    deposit: BigInt(view.depositWei), aiCap: BigInt(view.aiCapWei), ratingSnapshot: 0,
    expiresAt, nonce: randomNonce(),
  };
  const certificate = { wallet: author, action: PersonhoodAction.Publish, expiresAt, nonce: randomNonce() };
  const [quoteSignature, certificateSignature] = await Promise.all([
    signPublicationQuote(signer, chainId, market, quote),
    signPersonhoodCertificate(signer, chainId, market, certificate),
  ]);
  const stringify = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v as string | number]));
  return { quote: stringify(quote), quoteSignature, certificate: stringify(certificate), certificateSignature, expiresAt: Number(expiresAt) };
}

/**
 * Step 1. Freezes the draft, encrypts it, uploads to Arweave and re-reads the uploads
 * before returning a signed quote. Calling it again re-signs without re-uploading.
 */
export async function preparePublication(token: string | undefined, body: Record<string, unknown>) {
  const snapshot = await database(db => {
    const user = sessionUser(db, token);
    ensure(user, "Sign in to publish.", 401);
    ensure(user.worldIdVerifiedAt, "Verify your account with World ID before publishing.", 403);
    const project = ownedProject(db, user, body.id);
    ensure(!project.publication || project.publication.status === "quoted", "This comic is already on chain.", 409);
    if (!project.publication) {
      ensure(project.state === "draft", "This project is frozen.", 409);
      ensure(body.revision === project.revision, "Save your latest changes before publishing.", 409);
      ensure(project.panels.length > 0 && project.panels.every(p => p.image), "Every panel needs artwork before publishing.");
    }
    return { user, project: structuredClone(project) };
  });
  const { user, project } = snapshot;
  const { chainId, market } = chainConfig();

  let view = project.publication;
  if (!view) {
    const language = text(body.language ?? "en", 35, "Language").toLowerCase();
    ensure(LANGUAGE.test(language), "Use a language code such as en or pt-br.");
    const terms = publishingTerms();
    const price = BigInt(project.priceWei || "0");
    const policy = await getPolicy(terms.policyId);
    ensure(price >= policy.minPrice && price <= policy.maxPrice, `Set a price between ${policy.minPrice} and ${policy.maxPrice} wei.`);

    const contentKey = newContentKey();
    const bundle = buildBundle(project.panels, contentKey);
    const wrappedKey = wrapKey(contentKey, project.id);
    const tags = [{ name: "App-Name", value: "ConsentCraft" }];
    const cover = await previewImage(project.panels);
    const [bundleTxId, previewImageTxId] = await Promise.all([
      upload(bundle.bytes, "application/json", [...tags, { name: "Type", value: "encrypted-bundle" }]),
      upload(cover, "image/jpeg", [...tags, { name: "Type", value: "preview-image" }]),
    ]);
    const preview = previewManifest({ title: project.title, description: project.description, language, genre: project.genre.toLowerCase(), previewImageTxId });
    const previewTxId = await upload(preview.bytes, "application/json", [...tags, { name: "Type", value: "preview-manifest" }]);
    const uploaded: PublicationView = {
      status: "quoted", chainId, market, author: user.address,
      manifestHash: bundle.manifestHash, previewManifestHash: preview.hash, previewImageHash: keccak256(cover),
      bundleTxId, previewTxId, previewImageTxId, pageCount: bundle.pageCount, language,
      priceWei: price.toString(), depositWei: terms.deposit.toString(), aiCapWei: terms.aiCap.toString(), policyId: terms.policyId.toString(),
      updatedAt: new Date().toISOString(),
    };
    // Persist the uploads and freeze the draft before verification, so a slow
    // gateway never causes a second upload of different bytes.
    view = await database(db => {
      const current = ownedProject(db, user, project.id);
      ensure(!current.publication && current.revision === project.revision, "This project changed while it was being prepared. Try again.", 409);
      db.publicationSecrets ??= {};
      db.publicationSecrets[current.id] = { wrappedKey };
      current.publication = uploaded;
      current.state = "review";
      current.rosterFrozen = true;
      current.revision++;
      event(current, `${user.name} sealed the comic and stored it on Arweave.`);
      return uploaded;
    }, true);
  }
  ensure(view.chainId === chainId && view.market.toLowerCase() === market.toLowerCase(), "This draft was prepared for a different marketplace.", 409);

  // Never sign a quote for data the gateway does not serve byte-for-byte.
  try {
    await Promise.all([
      fetchVerified(view.bundleTxId, view.manifestHash, { attempts: 8, delayMs: 2500 }),
      fetchVerified(view.previewTxId, view.previewManifestHash, { attempts: 8, delayMs: 2500 }),
      ...(view.previewImageHash ? [fetchVerified(view.previewImageTxId, view.previewImageHash, { attempts: 8, delayMs: 2500 })] : []),
    ]);
  } catch (error) {
    if (error instanceof AppError && error.status === 503) {
      throw new AppError("Your comic is stored on Arweave, but the gateway is not serving it yet. Press Publish again in a minute; nothing will be uploaded twice.", 503);
    }
    throw error;
  }
  const signed = await signQuote(view, user.address);

  return database(db => {
    const current = ownedProject(db, user, project.id);
    ensure(current.publication?.status === "quoted" && current.publication.manifestHash === view!.manifestHash, "This comic changed or is already on chain.", 409);
    current.publication = { ...current.publication, quote: signed.quote, quoteSignature: signed.quoteSignature, quoteExpiresAt: signed.expiresAt, updatedAt: new Date().toISOString() };
    return { publication: current.publication, certificate: signed.certificate, certificateSignature: signed.certificateSignature };
  }, true);
}

function matchCreated(view: PublicationView, author: Address, events: { eventName: string; args: Record<string, unknown> }[]) {
  const created = events.find(e => e.eventName === "PublicationCreated"
    && getAddress(e.args.author as Address) === getAddress(author)
    && (e.args.manifestHash as Hex).toLowerCase() === view.manifestHash.toLowerCase());
  return created ? created.args.publicationId as bigint : undefined;
}

/** Step 2. Records the on-chain publication id from a confirmed transaction (or by searching the author's events). */
export async function confirmPublication(token: string | undefined, body: Record<string, unknown>) {
  const { user, project } = await database(db => {
    const user = sessionUser(db, token);
    ensure(user, "Sign in to publish.", 401);
    const project = ownedProject(db, user, body.id);
    ensure(project.publication, "Prepare the publication first.", 409);
    return { user, project: structuredClone(project) };
  });
  const view = project.publication!;
  if (view.publicationId) return { publication: view };

  let publicationId: bigint | undefined;
  let createTx: Hash | undefined;
  if (typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    createTx = body.txHash as Hash;
    const { receipt, events } = await confirmedMarketEvents(createTx);
    ensure(receipt.status === "success", "The publish transaction reverted on chain.", 409);
    publicationId = matchCreated(view, user.address, events as never);
  } else {
    const logs = await publicationsCreatedBy(user.address);
    const log = logs.find(l => (l.args.manifestHash as Hex).toLowerCase() === view.manifestHash.toLowerCase());
    if (log) { publicationId = log.args.publicationId; createTx = log.transactionHash; }
  }
  ensure(publicationId, "No confirmed publication for this comic was found yet.", 404);
  const onChain = await getPublication(publicationId);
  ensure(onChain.manifestHash.toLowerCase() === view.manifestHash.toLowerCase(), "On-chain publication does not match this comic.", 409);

  const result = await database(db => {
    const current = ownedProject(db, user, project.id);
    const pub = current.publication!;
    if (!pub.publicationId) {
      pub.publicationId = publicationId!.toString();
      pub.createTx = createTx;
      pub.status = "created";
      pub.quote = undefined; pub.quoteSignature = undefined; pub.quoteExpiresAt = undefined;
      pub.updatedAt = new Date().toISOString();
      current.publicationId = pub.publicationId;
      event(current, `${user.name} put the comic on chain as publication #${pub.publicationId}.`);
    }
    return { publication: pub };
  }, true);
  scheduleReview(project.id);
  return result;
}

/** Returns an un-submitted draft to editing. Refused once the publication exists on chain. */
export async function cancelPublication(token: string | undefined, body: Record<string, unknown>) {
  const { user, project } = await database(db => {
    const user = sessionUser(db, token);
    ensure(user, "Sign in first.", 401);
    const project = ownedProject(db, user, body.id);
    ensure(project.publication?.status === "quoted", "Only a draft that is not yet on chain can be reopened.", 409);
    return { user, project: structuredClone(project) };
  });
  const logs = await publicationsCreatedBy(user.address);
  ensure(!logs.some(l => (l.args.manifestHash as Hex).toLowerCase() === project.publication!.manifestHash.toLowerCase()),
    "This comic is already on chain. Confirm it instead.", 409);
  return database(db => {
    const current = ownedProject(db, user, project.id);
    ensure(current.publication?.status === "quoted", "Only a draft that is not yet on chain can be reopened.", 409);
    current.publication = undefined;
    delete db.publicationSecrets?.[current.id];
    current.state = "draft";
    current.rosterFrozen = false;
    current.revision++;
    event(current, `${user.name} reopened the comic for editing.`);
    return { ok: true };
  }, true);
}

