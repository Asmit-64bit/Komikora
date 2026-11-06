import { NextRequest, NextResponse } from "next/server";
import {
  isAddress,
  getAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signRequest } from "@worldcoin/idkit-server";

import {
  PersonhoodAction,
  randomNonce,
  signPersonhoodCertificate,
  type PersonhoodCertificate,
} from "@/lib/eip712";
import { getMarketplaceAddress } from "@/lib/contracts";

const headers = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers });
}

export async function GET(req: NextRequest) {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID || process.env.WORLD_APP_ID;
  const quoteSignerConfigured = Boolean(
    process.env.QUOTE_SIGNER_PRIVATE_KEY &&
      isHex(process.env.QUOTE_SIGNER_PRIVATE_KEY) &&
      process.env.QUOTE_SIGNER_PRIVATE_KEY.length === 66
  );

  const action = req.nextUrl.searchParams.get("action") || undefined;
  let rpContext = null;
  const signingKey = process.env.WORLD_SIGNING_KEY || process.env.QUOTE_SIGNER_PRIVATE_KEY;
  if (signingKey && isHex(signingKey)) {
    try {
      const cleanKey = signingKey.startsWith("0x") ? signingKey.slice(2) : signingKey;
      if (cleanKey.length === 64) {
        const rpSig = signRequest({
          signingKeyHex: cleanKey,
          action,
        });
        rpContext = {
          rp_id:
            process.env.WORLD_RP_ID ||
            (appId ? `rp_${appId.replace("app_", "")}` : "rp_consentcraft"),
          nonce: rpSig.nonce,
          created_at: rpSig.createdAt,
          expires_at: rpSig.expiresAt,
          signature: rpSig.sig,
        };
      }
    } catch {
      // Fallback
    }
  }

  return json({
    status: "online",
    service: "ConsentCraft World ID Personhood Attestation Bridge",
    appIdConfigured: Boolean(appId),
    quoteSignerConfigured,
    rpContext,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      wallet?: string;
      action?: "publish" | "purchase" | number;
      chainId?: number;
      proof?: {
        merkle_root?: string;
        nullifier_hash?: string;
        proof?: string;
        credential_type?: string;
      };
      signal?: string;
    };

    if (!body.wallet || !isAddress(body.wallet)) {
      return json({ error: "Invalid or missing wallet address." }, 400);
    }

    const wallet = getAddress(body.wallet);
    const actionNum =
      body.action === "publish" || body.action === 0
        ? PersonhoodAction.Publish
        : PersonhoodAction.Purchase;

    const appId =
      process.env.NEXT_PUBLIC_WORLD_APP_ID?.trim() ||
      process.env.WORLD_APP_ID?.trim();

    // Verify proof with Worldcoin API if app_id and proof are present
    if (appId && body.proof && body.proof.nullifier_hash) {
      const verifyRes = await fetch(
        `https://developer.worldcoin.org/api/v2/verify/${appId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body.proof,
            action: actionNum === PersonhoodAction.Publish ? "publish" : "purchase",
            signal: wallet,
          }),
        }
      );

      if (!verifyRes.ok) {
        const errorData = await verifyRes.json().catch(() => ({}));
        return json(
          {
            error: "World ID proof verification failed.",
            details: errorData,
          },
          400
        );
      }
    }

    // Prepare EIP-712 PersonhoodCertificate (valid for 15 minutes)
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
    const nonce = randomNonce();

    const certificate: PersonhoodCertificate = {
      wallet,
      action: actionNum,
      expiresAt,
      nonce,
    };

    // Sign certificate with QUOTE_SIGNER_ROLE
    const signerPk = process.env.QUOTE_SIGNER_PRIVATE_KEY?.trim();
    let signature: Hex = "0x";
    let signerAddress: Address | undefined;

    if (signerPk && isHex(signerPk) && signerPk.length === 66) {
      const quoteSigner = privateKeyToAccount(signerPk as Hex);
      signerAddress = quoteSigner.address;

      const chainId = body.chainId ?? Number(process.env.NEXT_PUBLIC_CHAIN_ID || 11155111);
      const marketAddress =
        getMarketplaceAddress() ||
        ("0x0000000000000000000000000000000000000000" as Address);

      signature = await signPersonhoodCertificate(
        quoteSigner,
        chainId,
        marketAddress,
        certificate
      );
    }

    return json({
      ok: true,
      certificate: {
        wallet: certificate.wallet,
        action: certificate.action,
        expiresAt: certificate.expiresAt.toString(),
        nonce: certificate.nonce.toString(),
      },
      signature,
      signer: signerAddress,
    });
  } catch (error) {
    console.error("Personhood certificate error:", error);
    return json({ error: (error as Error).message }, 500);
  }
}
