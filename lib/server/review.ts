import "server-only";
// AI review of a publication that is already on chain. It reviews exactly the
// Arweave bundle the contract fingerprints, using 0G Compute. Any failure leaves
// the publication Deposited with no signed report, so no deposit is ever forfeited
// because of a service error.
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytes32ToArweaveTxId } from "@/contracts/lib/arweave-tx-id";
import { randomBytes32, signReviewReport, type ReviewReport } from "@/lib/eip712";
import { database, ensure } from "@/lib/store";
import { fetchVerified } from "./arweave";
import { getPublication, market, publicClient, relayerClient } from "./chain";
import { openBundle, unwrapKey } from "./content";
import { chainConfig, privateKey } from "./env";
import { screenWith0G, SCREENING_PROMPT_VERSION, type Screening } from "./zg";
import type { Project } from "@/lib/types";

const DEPOSITED = 0;
const running = new Map<string, Promise<void>>();

/** Starts (or joins) the review for a project. Safe to call repeatedly. */
export function scheduleReview(projectId: string) {
  if (!running.has(projectId)) {
    running.set(projectId, runReview(projectId).catch(error => console.error("Review job failed", projectId, error)).finally(() => running.delete(projectId)));
  }
  return running.get(projectId)!;
}

async function setStatus(projectId: string, patch: (pub: NonNullable<Project["publication"]>, secrets: { wrappedKey: string; reviewReport?: unknown }) => void) {
  await database(db => {
    const project = db.projects.find(p => p.id === projectId);
    const secrets = db.publicationSecrets?.[projectId];
    if (!project?.publication || !secrets) return;
    patch(project.publication, secrets);
    project.publication.updatedAt = new Date().toISOString();
  }, true);
}

export type StoredReview = { manifestHash: Hex; screening: Screening; report: Record<string, unknown> };

async function runReview(projectId: string) {
  const loaded = await database(db => {
    const project = db.projects.find(p => p.id === projectId);
    const secrets = db.publicationSecrets?.[projectId];
    return project?.publication?.publicationId && secrets ? { view: structuredClone(project.publication), secrets: structuredClone(secrets) } : undefined;
  });
  if (!loaded || !["created", "review_failed", "reviewing"].includes(loaded.view.status)) return;
  const { view, secrets } = loaded;
  const publicationId = BigInt(view.publicationId!);
  await setStatus(projectId, pub => { pub.status = "reviewing"; pub.reviewError = undefined; });

  try {
    const onChain = await getPublication(publicationId);
    if (onChain.state !== DEPOSITED) {
      // Already reviewed (for example, a previous run's transaction landed).
      await setStatus(projectId, pub => { pub.status = "reviewed"; });
      return;
    }
    ensure(onChain.manifestHash.toLowerCase() === view.manifestHash.toLowerCase(), "On-chain fingerprint changed.", 409);

    // Reuse a completed screening for these exact bytes instead of paying for inference twice.
    const stored = secrets.reviewReport as StoredReview | undefined;
    let screening = stored?.manifestHash.toLowerCase() === view.manifestHash.toLowerCase() ? stored.screening : undefined;
    if (!screening) {
      const bundleTxId = bytes32ToArweaveTxId(onChain.arweaveBundleTxId);
      const bytes = await fetchVerified(bundleTxId, onChain.manifestHash);
      const pages = openBundle(bytes, onChain.manifestHash, unwrapKey(secrets.wrappedKey, projectId));
      screening = await screenWith0G(pages);
      const reviewed = screening;
      await setStatus(projectId, (_, s) => { s.reviewReport = { manifestHash: view.manifestHash, screening: reviewed, report: {} } satisfies StoredReview; });
    }

    // The contract caps recognized AI cost at aiCap; the author never pays more.
    const cost = BigInt(screening.costWei);
    const aiCost = cost < onChain.aiCap ? cost : onChain.aiCap;
    const reportBody = {
      schema: "consentcraft.review.v1", publicationId: publicationId.toString(), manifestHash: onChain.manifestHash,
      score: screening.score, flagged: screening.flagged, reasons: screening.reasons,
      provider: screening.provider, model: screening.model, teeVerified: screening.teeVerified, chatId: screening.chatId,
      inputTokens: screening.inputTokens, outputTokens: screening.outputTokens,
      zgCostNeuron: screening.zgCostNeuron, aiCostWei: aiCost.toString(), promptVersion: SCREENING_PROMPT_VERSION,
      at: screening.at,
    };
    const report: ReviewReport = {
      publicationId, manifestHash: onChain.manifestHash, arweaveBundleTxId: onChain.arweaveBundleTxId,
      // Only this hash goes on chain. The rationale stays private on the server.
      reportHash: keccak256(toHex(JSON.stringify(reportBody))),
      modelVersion: keccak256(toHex(`${screening.provider}:${screening.model}`)),
      promptVersion: keccak256(toHex(SCREENING_PROMPT_VERSION)),
      policyId: onChain.policyId, score: screening.score, flagged: screening.flagged, aiCost, jobId: randomBytes32(),
    };
    const { chainId, market: address, confirmations } = chainConfig();
    const reporter = privateKeyToAccount(privateKey("REPORTER_PRIVATE_KEY", "Review reports"));
    const signature = await signReviewReport(reporter, chainId, address, report);
    const relayer = relayerClient();
    const hash = await relayer.writeContract({ ...market(), functionName: "submitReviewReport", args: [publicationId, report, signature], chain: relayer.chain, account: relayer.account });
    const receipt = await publicClient().waitForTransactionReceipt({ hash, confirmations: Math.max(1, confirmations), timeout: 180_000 });
    ensure(receipt.status === "success", "The review transaction reverted.", 502);

    await setStatus(projectId, (pub, s) => {
      pub.status = "reviewed";
      pub.review = {
        score: screening.score, flagged: screening.flagged, aiCostWei: aiCost.toString(), model: screening.model, provider: screening.provider,
        teeVerified: screening.teeVerified, inputTokens: screening.inputTokens, outputTokens: screening.outputTokens, tx: hash, at: new Date().toISOString(),
      };
      s.reviewReport = { manifestHash: view.manifestHash, screening, report: reportBody } satisfies StoredReview;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setStatus(projectId, pub => { pub.status = "review_failed"; pub.reviewError = message.slice(0, 300); });
  }
}
