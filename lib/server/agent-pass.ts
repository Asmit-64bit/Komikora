import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { keccak256, toHex } from "viem";
import { database, ensure, sessionUser, type Database } from "@/lib/store";
import type { Project } from "@/lib/types";
import type { PublicationApproval } from "@/lib/approval-types";
import { envValue, NotConfiguredError } from "./env";
export const AGENT_PASS_COOKIE = "cc_publication_approval";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const random = () => randomBytes(32).toString("base64url");
export function agentPassConfig() {
  const clientId = envValue("WORLD_AGENTPASS_CLIENT_ID"); const secret = envValue("WORLD_AGENTPASS_CLIENT_SECRET");
  if (!clientId || !secret) throw new NotConfiguredError("World ID publication approval", ["WORLD_AGENTPASS_CLIENT_ID", "WORLD_AGENTPASS_CLIENT_SECRET"]);
  const issuer = envValue("WORLD_AGENTPASS_ISSUER") || "https://auth.world.org";
  ensure(["https://auth.world.org", "https://sandbox.auth.world.org"].includes(issuer), "Use an official World ID issuer.", 503);
  const origin = envValue("APP_ORIGIN") || envValue("NEXT_PUBLIC_APP_URL"); ensure(origin, "Set the application origin.", 503);
  const redirectUri = envValue("WORLD_AGENTPASS_REDIRECT_URI") || `${new URL(origin).origin}/api/agent-pass/callback`;
  ensure(new URL(redirectUri).origin === new URL(origin).origin, "World ID callback must use the application origin.", 503);
  const method = envValue("WORLD_AGENTPASS_AUTH_METHOD") || "client_secret_basic";
  ensure(["client_secret_basic", "client_secret_post"].includes(method), "Configure the registered World ID client authentication method.", 503);
  const acr = envValue("WORLD_AGENTPASS_ACR") || "https://world.org/oidc/acr/orb";
  ensure(["https://world.org/oidc/acr/orb", "https://world.org/oidc/acr/orb-face"].includes(acr), "Choose an explicit supported World ID assurance class.", 503);
  return { clientId, secret, issuer, redirectUri, method, acr };
}
export function publicationScope(project: Project) {
  const e = project.edition; ensure(e && e.status === "approved", "Complete curator review before requesting publication approval.", 409);
  return keccak256(toHex(JSON.stringify([project.id, project.ownerId, project.title, e.key, e.manifestHash, e.license, e.supply, e.chainId, e.contract.toLowerCase(), e.reserveWei || "10000000000000000", e.auctionDuration || 86400])));
}
function attemptFor(db: Database, token: string | undefined, id: string) {
  const user = sessionUser(db, token); ensure(user && token, "Sign in with the creator wallet.", 401);
  const attempt = db.publicationApprovals?.find(a => a.id === id && a.userId === user.id && a.sessionHash === hash(token));
  ensure(attempt, "Approval request not found for this session.", 404);
  const project = db.projects.find(p => p.id === attempt.projectId && p.ownerId === user.id); ensure(attempt.kind === "identity" || project, "Project not found.", 404);
  ensure(attempt.expiresAt > Date.now(), "This approval request expired. Start a new request.", 409);
  if (project) ensure(publicationScope(project) === attempt.scopeHash, "The comic or auction terms changed. Request a new approval.", 409);
  return { user, attempt, project };
}
async function discovery(cfg: ReturnType<typeof agentPassConfig>) {
  const response = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), cache: "no-store" });
  ensure(response.ok, "World ID discovery is unavailable.", 502);
  const d = await response.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
  ensure(d.issuer === cfg.issuer && [d.authorization_endpoint, d.token_endpoint, d.jwks_uri].every(u => typeof u === "string" && new URL(u).origin === cfg.issuer), "Invalid World ID discovery metadata.", 502);
  return d;
}
export async function startPublicationApproval(token: string | undefined, projectId: unknown, allowEnrollment: boolean, identityOnly = false) {
  const cfg = agentPassConfig(); const d = await discovery(cfg); const binding = random();
  const attempt = await database(db => {
    const user = sessionUser(db, token); ensure(user && token, "Sign in first.", 401);
    const p = db.projects.find(p => p.id === projectId && p.ownerId === user.id); ensure(identityOnly || p, "Project not found.", 404);
    if (!identityOnly) ensure(user.worldIdVerifiedAt, "Complete creator verification first.", 403);
    const account = db.users.find(a => a.id === user.id)!;
    ensure(account.worldIdentity || allowEnrollment, "Approve linking this World ID to your creator account.");
    db.publicationApprovals = (db.publicationApprovals || []).filter(a => a.expiresAt > Date.now());
    for (const old of db.publicationApprovals) if (old.userId === user.id && old.projectId === (identityOnly ? "" : p!.id) && old.status !== "used") old.status = "cancelled";
    const a: PublicationApproval = { id: random(), userId: user.id, projectId: identityOnly ? "" : p!.id, sessionHash: hash(token), bindingHash: hash(binding), scopeHash: identityOnly ? keccak256(toHex(`${user.id}:${user.address}`)) : publicationScope(p!), state: random(), nonce: random(), verifier: random(), createdAt: Date.now(), expiresAt: Date.now() + 600000, status: "pending", allowEnrollment, acr: cfg.acr, issuer: cfg.issuer, kind: identityOnly ? "identity" : "publication" };
    db.publicationApprovals.push(a); if (!identityOnly) p!.edition!.approvalId = a.id; return a;
  }, true);
  const url = new URL(d.authorization_endpoint);
  for (const [k,v] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: "openid", state: attempt.state, nonce: attempt.nonce,
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"), code_challenge_method: "S256", max_age: "0", claims: JSON.stringify({ id_token: { acr: { essential: true, value: cfg.acr } } }) })) url.searchParams.set(k,v);
  return { id: attempt.id, url: url.href, binding };
}
export function validateWorldClaims(claims: JWTPayload, attempt: PublicationApproval, issuer: string) {
  ensure(typeof claims.sub === "string" && claims.sub.length > 0 && claims.nonce === attempt.nonce, "World ID identity or nonce mismatch.", 401);
  ensure(claims.acr === attempt.acr && Array.isArray(claims.amr) && claims.amr.length > 0, "World ID did not satisfy the required assurance.", 401);
  ensure(typeof claims.auth_time === "number" && claims.auth_time >= Math.floor(attempt.createdAt / 1000) - 30 && claims.auth_time <= Date.now() / 1000 + 30, "World ID authentication was not fresh for this request.", 401);
  return { identity: hash(`${issuer}\n${claims.sub}`), authTime: claims.auth_time };
}
export async function finishPublicationApproval(params: URLSearchParams, binding?: string) {
  const cfg = agentPassConfig();
  const attempt = await database(db => {
    const a = db.publicationApprovals?.find(a => a.state === params.get("state"));
    ensure(a && binding && a.bindingHash === hash(binding), "World ID request does not match this browser.", 401);
    ensure(a.status === "pending" && a.expiresAt > Date.now(), "World ID request expired or was already used.", 409);
    const activeSession = db.sessions.find(s => hash(s.token) === a.sessionHash && s.userId === a.userId && s.expires > Date.now());
    ensure(activeSession, "The initiating wallet session ended.", 401);
    a.status = "exchanging"; return structuredClone(a);
  }, true);
  try {
    ensure(params.get("iss") === cfg.issuer && attempt.issuer === cfg.issuer, "Unexpected World ID response issuer.", 401);
    ensure(!params.has("error") && params.get("code"), "World ID approval was denied or cancelled.", 403);
    const d = await discovery(cfg);
    const form = new URLSearchParams({ grant_type: "authorization_code", code: params.get("code")!, redirect_uri: cfg.redirectUri, code_verifier: attempt.verifier });
    const headers: Record<string,string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (cfg.method === "client_secret_basic") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.secret)}`).toString("base64")}`;
    else { form.set("client_id", cfg.clientId); form.set("client_secret", cfg.secret); }
    const response = await fetch(d.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(Math.min(15000, Math.max(1, attempt.expiresAt - Date.now()))) });
    ensure(response.ok, "World ID code exchange failed. Start a fresh request.", 401);
    const body = await response.json() as { id_token?: string }; ensure(typeof body.id_token === "string", "World ID returned no identity token.", 401);
    const { payload } = await jwtVerify(body.id_token, createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 10000, cooldownDuration: 30000 }), { issuer: cfg.issuer, audience: cfg.clientId, algorithms: ["RS256"], requiredClaims: ["sub", "iat", "exp", "nonce", "auth_time", "acr", "amr"], maxTokenAge: 600, clockTolerance: 30 });
    const verified = validateWorldClaims(payload, attempt, cfg.issuer);
    await database(db => {
      const a = db.publicationApprovals!.find(a => a.id === attempt.id)!;
      ensure(a.status === "exchanging" && a.expiresAt > Date.now(), "Approval expired or was cancelled.", 409);
      const account = db.users.find(u => u.id === a.userId)!;
      ensure(!account.worldIdentity || account.worldIdentity === verified.identity, "A different World ID was used for this creator.", 403);
      a.identity = verified.identity; a.authTime = verified.authTime; a.status = "authenticated";
    }, true);
  } catch {
    await database(db => { const a = db.publicationApprovals?.find(a => a.id === attempt.id); if (a && a.status === "exchanging") { a.status = "failed"; a.error = "World ID authentication failed, was denied, or expired. Publication remains blocked."; } }, true);
  }
  return attempt.id;
}
export async function readPublicationApproval(token: string | undefined, id: string) {
  return database(db => {
    const { attempt, project } = attemptFor(db, token, id);
    return { id: attempt.id, kind: attempt.kind, environment: attempt.issuer.includes("sandbox") ? "sandbox" : "production", status: attempt.status, error: attempt.error, expiresAt: attempt.expiresAt, projectId: project?.id || "", title: project?.title || "Verify creator identity", supply: project?.edition!.supply || 0,
      reserveWei: project?.edition!.reserveWei || "10000000000000000", duration: project?.edition!.auctionDuration || 86400, license: project?.edition!.license || "Link this World ID to your creator wallet.", manifestHash: project?.edition!.manifestHash || "" };
  });
}
export async function decidePublicationApproval(token: string | undefined, id: string, approved: boolean) {
  return database(db => {
    const { attempt, user } = attemptFor(db, token, id);
    ensure(attempt.status === "authenticated", "Complete fresh World ID authentication before deciding.", 409);
    if (!approved) { attempt.status = "denied"; return { status: attempt.status }; }
    const account = db.users.find(u => u.id === user.id)!;
    ensure(attempt.identity && (!account.worldIdentity ? attempt.allowEnrollment : account.worldIdentity === attempt.identity), "World ID account binding failed.", 403);
    ensure(!db.users.some(u => u.id !== user.id && u.worldIdentity === attempt.identity), "This World ID is already linked to another creator.", 409);
    account.worldIdentity = attempt.identity; attempt.status = "approved";
    if (attempt.kind === "identity") { account.worldIdVerifiedAt = new Date().toISOString(); account.worldIdEnvironment = attempt.issuer.includes("sandbox") ? "sandbox" : "production"; }
    return { status: attempt.status };
  }, true);
}
export async function reservePublicationApproval(token: string | undefined, project: Project): Promise<bigint> {
  agentPassConfig();
  return database(db => {
    ensure(project.edition?.approvalId, "Approve this publication with World ID before minting.", 403);
    const { attempt } = attemptFor(db, token, project.edition.approvalId);
    ensure(attempt.kind !== "identity" && attempt.projectId === project.id, "A publication-specific approval is required.", 403);
    ensure(project.edition.chainId === 31337 || attempt.issuer === "https://auth.world.org", "Sandbox identity cannot authorize a public deployment.", 403);
    ensure(attempt.status === "approved" || attempt.status === "used", "This publication was not approved. Minting remains blocked.", 403);
    attempt.status = "used"; return BigInt(Math.floor(attempt.expiresAt / 1000));
  }, true);
}
