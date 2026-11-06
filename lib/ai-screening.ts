import "server-only";

import OpenAI from "openai";
import sharp from "sharp";
import {
  keccak256,
  toHex,
  parseEther,
  type Hex,
  type Address,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Panel } from "@/lib/types";
import {
  signReviewReport,
  randomBytes32,
  type ReviewReport,
} from "@/lib/eip712";

export const SCREENING_PROMPT_VERSION = "consentcraft-0g-vision-v1.0.0";
export const DEFAULT_ZG_MODEL = "meta-llama/Llama-3.2-11B-Vision-Instruct";
export const DEFAULT_ZG_BASE_URL = "https://compute-router.0g.ai/v1";

export type ScreeningReport = {
  technicalValidity: boolean;
  score: number; // 0 - 100
  flagged: boolean;
  reasons: string[];
  uncertainty: number;
  panelsReviewed: number;
  modelVersion: string;
  promptVersion: string;
  deterministicFlags: string[];
  timestamp: string;
};

export type ScreeningJobInput = {
  publicationId: bigint;
  manifestHash: Hex;
  arweaveBundleTxId: Hex;
  policyId?: bigint;
  aiCap?: bigint;
  panels: Panel[];
  chainId?: number;
  marketAddress?: Address;
};

export type ScreeningJobResult = {
  screening: ScreeningReport;
  report: ReviewReport;
  signature?: Hex;
  signerAddress?: Address;
};

/**
 * Cheap deterministic checks before paid inference.
 * Detects missing images, corrupt files, and blank/solid color canvases.
 */
export async function runDeterministicChecks(panels: Panel[]): Promise<{
  passed: boolean;
  flags: string[];
}> {
  const flags: string[] = [];

  if (!panels || panels.length !== 4) {
    flags.push(`Invalid panel count: expected 4, got ${panels ? panels.length : 0}`);
  }

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (!panel || !panel.image || !panel.image.trim()) {
      flags.push(`Panel ${i + 1}: Image is empty or missing`);
      continue;
    }

    try {
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        panel.image.trim()
      );
      const buffer = match
        ? Buffer.from(match[2], "base64")
        : Buffer.from(panel.image, "base64");

      const img = sharp(buffer);
      const metadata = await img.metadata();

      if (!metadata.width || !metadata.height || metadata.width < 10 || metadata.height < 10) {
        flags.push(`Panel ${i + 1}: Image dimensions too small (${metadata.width}x${metadata.height})`);
        continue;
      }

      // Check for uniform/blank image using channel standard deviations
      const stats = await img.stats();
      const isUniform = stats.channels.every((c) => c.stdev < 1.5);
      if (isUniform) {
        flags.push(`Panel ${i + 1}: Image is blank or uniform solid color`);
      }
    } catch (err) {
      flags.push(`Panel ${i + 1}: Corrupt image data (${(err as Error).message})`);
    }
  }

  return {
    passed: flags.length === 0,
    flags,
  };
}

/**
 * Initializes the OpenAI-compatible client for 0G Compute Router.
 */
export function get0GRouterClient(): {
  client: OpenAI;
  model: string;
  isMock: boolean;
} {
  const apiKey = process.env.ZG_COMPUTE_API_KEY?.trim();
  const baseURL = process.env.ZG_COMPUTE_BASE_URL?.trim() || DEFAULT_ZG_BASE_URL;
  const model = process.env.ZG_COMPUTE_MODEL?.trim() || DEFAULT_ZG_MODEL;

  if (!apiKey) {
    // Return mock client when API key is not yet configured
    return {
      client: new OpenAI({ apiKey: "mock-key", baseURL }),
      model,
      isMock: true,
    };
  }

  return {
    client: new OpenAI({ apiKey, baseURL }),
    model,
    isMock: false,
  };
}

/**
 * Submits multimodal image screening to the 0G Router.
 */
export async function screenComicWith0G(
  panels: Panel[],
  title = "Untitled Comic"
): Promise<ScreeningReport> {
  const deterministic = await runDeterministicChecks(panels);

  // If deterministic checks caught fatal issues (like blank panels), flag immediately
  if (!deterministic.passed) {
    return {
      technicalValidity: false,
      score: 10,
      flagged: true,
      reasons: deterministic.flags,
      uncertainty: 0.0,
      panelsReviewed: panels.length,
      modelVersion: "deterministic-v1",
      promptVersion: SCREENING_PROMPT_VERSION,
      deterministicFlags: deterministic.flags,
      timestamp: new Date().toISOString(),
    };
  }

  const { client, model, isMock } = get0GRouterClient();

  if (isMock) {
    return {
      technicalValidity: true,
      score: 85,
      flagged: false,
      reasons: [
        "Verified 4 sequential graphic panels",
        "Deterministic integrity checks passed with healthy pixel distribution",
        "0G Router offline simulation mode (set ZG_COMPUTE_API_KEY for live endpoint)",
      ],
      uncertainty: 0.05,
      panelsReviewed: 4,
      modelVersion: `mock-${model}`,
      promptVersion: SCREENING_PROMPT_VERSION,
      deterministicFlags: [],
      timestamp: new Date().toISOString(),
    };
  }

  // Format multimodal request with images
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `You are the ConsentCraft Automated Comic Screening Agent.
Evaluate the attached 4 sequential comic panels for the comic titled "${title}".
Review criteria:
1. Technical Validity: Are panels non-corrupt, appropriately rendered, readable art?
2. Spam & Quality: Is this genuine comic sequential art or spam/gibberish?
3. Content Warnings & Safety: Flag any illegal, explicitly non-consensual or malicious content.
4. Advisory Score: Integer from 0 (lowest) to 100 (highest) reflecting comic production quality.

Respond ONLY with valid JSON conforming to this schema:
{
  "technicalValidity": boolean,
  "score": number, // 0 to 100
  "flagged": boolean,
  "reasons": string[], // Concise bullet explanations
  "uncertainty": number // 0.0 to 1.0
}`,
    },
  ];

  for (let i = 0; i < panels.length; i++) {
    const imgData = panels[i].image.trim();
    const url = imgData.startsWith("data:") ? imgData : `data:image/jpeg;base64,${imgData}`;
    userContent.push({
      type: "image_url",
      image_url: {
        url,
        detail: "auto",
      },
    });
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a strict, objective AI comic screening system. Return output exclusively as valid JSON.",
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 800,
    });

    const choice = response.choices[0];
    const contentText = choice?.message?.content?.trim();

    if (!contentText) {
      throw new Error("Empty response from 0G vision router.");
    }

    const parsed = JSON.parse(contentText) as {
      technicalValidity?: boolean;
      score?: number;
      flagged?: boolean;
      reasons?: string[];
      uncertainty?: number;
    };

    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 75)));
    const flagged = Boolean(parsed.flagged);
    const technicalValidity = parsed.technicalValidity !== false;
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : ["Review completed"];
    const uncertainty = typeof parsed.uncertainty === "number" ? parsed.uncertainty : 0.1;

    return {
      technicalValidity,
      score,
      flagged,
      reasons,
      uncertainty,
      panelsReviewed: 4,
      modelVersion: model,
      promptVersion: SCREENING_PROMPT_VERSION,
      deterministicFlags: [],
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Per the report: service errors must enter a review-error state and NEVER forfeit deposits
    throw new Error(`0G Compute Router inference failed: ${(err as Error).message}`);
  }
}

/**
 * Runs the full worker pipeline:
 * 1. Screens comic panels via deterministic checks + 0G multimodal vision
 * 2. Compiles cryptographic report parameters
 * 3. Signs ReviewReport using REPORTER_ROLE if private key is available
 */
export async function executeScreeningPipeline(
  input: ScreeningJobInput
): Promise<ScreeningJobResult> {
  const screening = await screenComicWith0G(input.panels);

  const reportHash = keccak256(toHex(JSON.stringify(screening)));
  const modelVersion = keccak256(toHex(screening.modelVersion));
  const promptVersion = keccak256(toHex(screening.promptVersion));
  const jobId = randomBytes32();

  // Bounded AI cost in wei (e.g. 0.0001 ETH, respecting aiCap)
  const defaultCost = parseEther("0.0001");
  const aiCost = input.aiCap && input.aiCap < defaultCost ? input.aiCap : defaultCost;

  // Score scaled to uint16 (0 - 10000)
  const scaledScore = Math.min(10000, screening.score * 100);

  const report: ReviewReport = {
    publicationId: input.publicationId,
    manifestHash: input.manifestHash,
    arweaveBundleTxId: input.arweaveBundleTxId,
    reportHash,
    modelVersion,
    promptVersion,
    policyId: input.policyId ?? BigInt(1),
    score: scaledScore,
    flagged: screening.flagged,
    aiCost,
    jobId,
  };

  const reporterPk = process.env.REPORTER_PRIVATE_KEY?.trim();
  let signature: Hex | undefined;
  let signerAddress: Address | undefined;

  if (reporterPk && isHex(reporterPk) && reporterPk.length === 66) {
    const reporterAccount = privateKeyToAccount(reporterPk as Hex);
    signerAddress = reporterAccount.address;

    const chainId = input.chainId ?? 11155111; // Sepolia default
    const market = input.marketAddress ?? (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS as Address);

    if (market) {
      signature = await signReviewReport(reporterAccount, chainId, market, report);
    }
  }

  return {
    screening,
    report,
    signature,
    signerAddress,
  };
}
