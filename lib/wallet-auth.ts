import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { ensure, id, publicUser, text, type Database } from "./store";
import type { User } from "./types";

export const SESSION_COOKIE = "cc_session";
const CHALLENGE_COOKIE = "cc_wallet_challenge";
const LIFETIME = 5 * 60 * 1000;
const headers = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

export function walletAddress(value: unknown): `0x${string}` {
  const address = text(value, 42, "Wallet address");
  ensure(isAddress(address, { strict: false }), "Enter a valid Ethereum wallet address.");
  return getAddress(address);
}

// The server constructs and retains the entire message. The client cannot alter
// its origin, nonce, address, chain, or expiration when submitting a signature.
export async function walletAuth(req: NextRequest, body: Record<string, unknown>, db: Database): Promise<NextResponse | undefined> {
  const action = body.action;
  if (!["challenge", "siwe", "logout"].includes(String(action))) return;
  const origin = req.headers.get("origin")!; // Validated by the route before entry.
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const browserChallenge = req.cookies.get(CHALLENGE_COOKIE)?.value;
  const cookieOptions = { httpOnly: true, sameSite: "strict" as const, secure: origin.startsWith("https:"), path: "/" };
  db.walletChallenges ??= [];

  if (action === "logout") {
    db.sessions = db.sessions.filter(session => session.token !== token);
    db.walletChallenges = db.walletChallenges.filter(challenge => challenge.id !== browserChallenge);
    const response = json({ ok: true });
    response.cookies.delete(SESSION_COOKIE);
    response.cookies.delete(CHALLENGE_COOKIE);
    return response;
  }
  if (action === "challenge") {
    const address = walletAddress(body.address);
    ensure(Number.isSafeInteger(body.chainId) && Number(body.chainId) > 0, "Invalid wallet chain.");
    const now = Date.now();
    const expires = now + LIFETIME;
    db.walletChallenges = db.walletChallenges.filter(challenge => challenge.expires > now && challenge.id !== browserChallenge);
    ensure(db.walletChallenges.length < 1000, "Too many sign-in requests. Please try again later.", 429);
    const challengeId = id();
    const message = createSiweMessage({
      address, chainId: Number(body.chainId), domain: new URL(origin).host, uri: origin,
      version: "1", nonce: id(), issuedAt: new Date(now), expirationTime: new Date(expires),
      statement: "Sign in to ConsentCraft. This message does not authorize transactions or cost gas.",
    });
    db.walletChallenges.push({ id: challengeId, address, message, origin, expires });
    const response = json({ message });
    response.cookies.set(CHALLENGE_COOKIE, challengeId, { ...cookieOptions, maxAge: LIFETIME / 1000 });
    return response;
  }

  const challenge = db.walletChallenges.find(value => value.id === browserChallenge);
  // Consume on every verification attempt, including bad signatures. Return a
  // response instead of throwing so the database commits the consumed nonce.
  db.walletChallenges = db.walletChallenges.filter(value => value.id !== browserChallenge && value.expires > Date.now());
  const reject = (message: string) => {
    const response = json({ error: message }, 401);
    response.cookies.delete(CHALLENGE_COOKIE);
    return response;
  };
  if (!challenge || challenge.expires <= Date.now()) return reject("Your wallet sign-in request expired or was already used. Please try again.");
  if (challenge.origin !== origin || body.message !== challenge.message) return reject("This sign-in message does not match the request from this browser.");
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return reject("Invalid wallet signature. Use a standard Ethereum account.");
  let verified = false;
  try { verified = await verifyMessage({ address: challenge.address, message: challenge.message, signature: body.signature as Hex }); } catch {}
  if (!verified) return reject("The signature did not match your wallet. Please try again.");

  let account = db.users.find(user => user.address?.toLowerCase() === challenge.address.toLowerCase()) as User | undefined;
  if (!account) {
    account = { id: id(), name: `${challenge.address.slice(0, 6)}…${challenge.address.slice(-4)}`, color: "purple", address: challenge.address };
    db.users.push(account);
  }
  const sessionToken = id();
  db.sessions = db.sessions.filter(session => session.auth === "wallet" && session.expires > Date.now() && session.token !== token);
  db.sessions.push({ token: sessionToken, userId: account.id, auth: "wallet", expires: Date.now() + 7 * 86400000 });
  const response = json({ ok: true, user: publicUser(account) });
  response.cookies.set(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: 7 * 86400 });
  response.cookies.delete(CHALLENGE_COOKIE);
  return response;
}
