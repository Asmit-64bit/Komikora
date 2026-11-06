import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import { PersonhoodAction, randomNonce, signPersonhoodCertificate } from "@/lib/eip712";
import { database, ensure, sessionUser } from "@/lib/store";
import { chainConfig, privateKey } from "./env";

/** Existing market deployments retain this certificate ABI; it now authorizes a
 * signed-in wallet purchase and makes no claim about identity or uniqueness. */
export async function authorizeLegacyPurchase(token: string | undefined) {
  const user = await database(db => sessionUser(db, token));
  ensure(user, "Sign in with your wallet first.", 401);
  const { chainId, market } = chainConfig();
  const signer = privateKeyToAccount(privateKey("QUOTE_SIGNER_PRIVATE_KEY", "Legacy purchase authorization"));
  const certificate = {
    wallet: user.address,
    action: PersonhoodAction.Purchase,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 10 * 60),
    nonce: randomNonce(),
  };
  return { certificate, signature: await signPersonhoodCertificate(signer, chainId, market, certificate) };
}
