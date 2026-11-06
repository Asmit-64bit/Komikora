// World ID 4 verification and personhood certificates for the signed-in wallet.
// A certificate is signed only for a session whose account passed World ID, and it
// is bound to that session's wallet. There is no path that signs without a proof.
import type { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { PersonhoodAction, randomNonce, signPersonhoodCertificate } from "@/lib/eip712";
import { database, ensure, sessionUser } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { chainConfig, envValue, hasKey, privateKey } from "@/lib/server/env";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { completeVerification, startVerification } from "@/lib/server/world-id";

const CERTIFICATE_TTL_SECONDS = 10 * 60;

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const user = await database(db => sessionUser(db, token));
    return json({
      configured: !!(envValue("NEXT_PUBLIC_WORLD_APP_ID") && envValue("WORLD_RP_ID") && envValue("WORLD_RP_SIGNING_KEY")),
      certificatesConfigured: hasKey("QUOTE_SIGNER_PRIVATE_KEY"),
      verifiedAt: user?.worldIdVerifiedAt ?? null,
    });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req, 200_000);
    rateLimit(req, "personhood", 30);
    const token = req.cookies.get(SESSION_COOKIE)?.value;

    if (body.step === "start") {
      return json(await database(db => {
        const user = sessionUser(db, token);
        ensure(user, "Sign in with your wallet first.", 401);
        return startVerification(db, user);
      }, true));
    }

    if (body.step === "complete") {
      return json(await database(async db => {
        const user = sessionUser(db, token);
        ensure(user, "Sign in with your wallet first.", 401);
        return completeVerification(db, user, body.result);
      }, true));
    }

    ensure(body.step === "certificate", "Unknown step.");
    ensure(body.action === "purchase" || body.action === "publish", "Choose purchase or publish.");
    const user = await database(db => sessionUser(db, token));
    ensure(user, "Sign in with your wallet first.", 401);
    ensure(user.worldIdVerifiedAt, "Verify your account with World ID first.", 403);
    const { chainId, market } = chainConfig();
    const signer = privateKeyToAccount(privateKey("QUOTE_SIGNER_PRIVATE_KEY", "Personhood certificates"));
    const certificate = {
      wallet: user.address,
      action: body.action === "publish" ? PersonhoodAction.Publish : PersonhoodAction.Purchase,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + CERTIFICATE_TTL_SECONDS),
      nonce: randomNonce(),
    };
    const signature = await signPersonhoodCertificate(signer, chainId, market, certificate);
    return json({ certificate, signature });
  } catch (error) { return failure(error); }
}
