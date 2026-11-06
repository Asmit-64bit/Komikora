import { NextRequest, NextResponse } from "next/server";
import { database, ensure, sessionUser } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import {
  executeScreeningPipeline,
  get0GRouterClient,
  DEFAULT_ZG_BASE_URL,
} from "@/lib/ai-screening";
import type { Panel, Project } from "@/lib/types";
import { keccak256, toHex, type Hex, isHex } from "viem";

const headers = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers });
}

export async function GET() {
  const { model, isMock } = get0GRouterClient();
  const reporterConfigured = Boolean(
    process.env.REPORTER_PRIVATE_KEY &&
      isHex(process.env.REPORTER_PRIVATE_KEY) &&
      process.env.REPORTER_PRIVATE_KEY.length === 66
  );

  return json({
    status: "online",
    provider: "0G Compute Router",
    model,
    baseURL: process.env.ZG_COMPUTE_BASE_URL || DEFAULT_ZG_BASE_URL,
    offlineMode: isMock,
    reporterConfigured,
  });
}

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const body = (await req.json()) as {
      projectId?: string;
      publicationId?: string;
      panels?: Panel[];
      manifestHash?: Hex;
      arweaveBundleTxId?: Hex;
      policyId?: string;
      aiCap?: string;
    };

    let panels: Panel[] = [];
    let publicationId = BigInt(1);
    let manifestHash: Hex = keccak256(toHex("sample-manifest"));
    let arweaveBundleTxId: Hex = keccak256(toHex("sample-bundle"));

    if (body.projectId) {
      // Load project from local database
      await database((db) => {
        const user = sessionUser(db, token);
        ensure(user, "Sign in to review comics.", 401);

        const project = db.projects.find((p: Project) => p.id === body.projectId);
        ensure(project, "Project not found.", 404);
        ensure(
          project.members.some((m) => m.userId === user.id),
          "Not authorized to review this project.",
          403
        );

        panels = project.panels;
        if (project.publicationId && /^\d+$/.test(project.publicationId)) {
          publicationId = BigInt(project.publicationId);
        }
      });
    } else if (Array.isArray(body.panels)) {
      panels = body.panels;
      if (body.publicationId && /^\d+$/.test(body.publicationId)) {
        publicationId = BigInt(body.publicationId);
      }
    } else {
      ensure(false, "Provide a projectId or panels array.", 400);
    }

    if (body.manifestHash && isHex(body.manifestHash)) {
      manifestHash = body.manifestHash;
    }
    if (body.arweaveBundleTxId && isHex(body.arweaveBundleTxId)) {
      arweaveBundleTxId = body.arweaveBundleTxId;
    }

    const policyId = body.policyId ? BigInt(body.policyId) : BigInt(1);
    const aiCap = body.aiCap ? BigInt(body.aiCap) : undefined;

    const result = await executeScreeningPipeline({
      publicationId,
      manifestHash,
      arweaveBundleTxId,
      policyId,
      aiCap,
      panels,
    });

    return json({
      ok: true,
      screening: result.screening,
      report: {
        ...result.report,
        publicationId: result.report.publicationId.toString(),
        policyId: result.report.policyId.toString(),
        aiCost: result.report.aiCost.toString(),
      },
      signature: result.signature,
      signer: result.signerAddress,
    });
  } catch (error) {
    console.error("0G screening error:", error);
    return json({ error: (error as Error).message }, 500);
  }
}
