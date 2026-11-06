// Adapted from Asmit-64bit/consentcraft. This API covers the offchain studio only.
import { NextRequest, NextResponse } from "next/server";
import { AppError, database, ensure, event, id, publicUser, sessionUser, text } from "@/lib/store";
import { walletAuth, walletAddress, SESSION_COOKIE } from "@/lib/wallet-auth";
import { validateImage } from "@/lib/images";
import type { Panel, Project } from "@/lib/types";

const headers = { "Cache-Control": "no-store" };
const SESSION = SESSION_COOKIE;
const MAX_BODY = 16_000_000;
function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers }); }
function failure(error: unknown) {
  if (!(error instanceof AppError)) console.error("Studio request failed", error);
  return json({ error: error instanceof AppError ? error.message : "Something went wrong. Please try again." }, error instanceof AppError ? error.status : 500);
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  ensure(host && (origin === `http://${host}` || origin === `https://${host}`), "Request origin is not allowed.", 403);
  ensure(req.headers.get("content-type")?.split(";")[0].trim() === "application/json", "Send JSON data.", 415);
  ensure(Number(req.headers.get("content-length") || 0) <= MAX_BODY, "This upload is too large.", 413);
  const reader = req.body?.getReader();
  ensure(reader, "Invalid request.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new AppError("This upload is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("Invalid JSON request."); }
  ensure(body && typeof body === "object" && !Array.isArray(body), "Invalid request.");
  return body as Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION)?.value;
    const projectId = req.nextUrl.searchParams.get("invitations");
    return await database(db => {
      const user = sessionUser(db, token);
      if (projectId) {
        ensure(user && db.projects.some(p => p.id === projectId && p.ownerId === user.id), "Project not found.", 404);
        return json({ invitations: db.invitations.filter(i => i.address && i.projectId === projectId && !i.accepted && Date.parse(i.expiresAt) > Date.now()) });
      }
      const invitations = user ? db.invitations.flatMap(i => {
        if (i.accepted || Date.parse(i.expiresAt) <= Date.now() || i.address?.toLowerCase() !== user.address.toLowerCase()) return [];
        const project = db.projects.find(p => p.id === i.projectId && !p.rosterFrozen && p.state === "draft");
        return project ? [{ ...i, projectTitle: project.title, ownerName: project.members.find(m => m.userId === project.ownerId)?.name || "Project owner" }] : [];
      }) : [];
      return json({
        user: user ? publicUser(user) : null,
        projects: user ? db.projects.filter(p => p.members.some(m => m.userId === user.id)) : [],
        // Publication requires the separate wallet/contract integration.
        comics: [], invitations,
      });
    });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    return await database(async db => {
      const action = b.action;
      const token = req.cookies.get(SESSION)?.value;
      const authResponse = await walletAuth(req, b, db);
      if (authResponse) return authResponse;
      ensure(action !== "signup" && action !== "login", "Use your wallet to sign in. Email and password authentication is disabled.", 400);
      const user = sessionUser(db, token);
      ensure(user, "Sign in to use your studio.", 401);
      if (action === "create") {
        const now = new Date().toISOString();
        const project: Project = {
          id: id(), ownerId: user.id, title: text(b.title, 80, "Title"),
          description: text(b.description ?? "", 1000, "Description", false), genre: text(b.genre ?? "Original comic", 60, "Genre"), theme: "",
          members: [{ userId: user.id, name: user.name, address: user.address, role: "Creator", share: 10000 }],
          panels: Array.from({ length: 4 }, () => ({ image: "", dialogue: "", alt: "" })),
          state: "draft", revision: 1, version: 0, approvals: [], rosterFrozen: false,
          terms: "Personal reading and sharing a link are welcome. Artwork belongs to its creators. Commercial reuse requires permission from all contributors.",
          priceWei: "0", createdAt: now, updatedAt: now, events: [],
        };
        event(project, `${user.name} started a new story.`);
        db.projects.unshift(project);
        return json({ id: project.id });
      }
      if (action === "accept") {
        const invitation = db.invitations.find(i => i.id === b.token);
        ensure(invitation && !invitation.accepted && Date.parse(invitation.expiresAt) > Date.now(), "This invitation has expired or was already used.", 404);
        ensure(invitation.address?.toLowerCase() === user.address.toLowerCase(), "Sign in with the wallet this invitation was created for.", 403);
        const project = db.projects.find(p => p.id === invitation.projectId);
        ensure(project && !project.rosterFrozen && project.state === "draft", "This team is closed to new collaborators.", 409);
        ensure(!project.members.some(m => m.userId === user.id), "You're already on this team.", 409);
        project.members.push({ userId: user.id, name: user.name, address: user.address, role: "Collaborator", share: 0 });
        project.revision++;
        invitation.accepted = true;
        event(project, `${user.name} joined the team.`);
        return json({ id: project.id });
      }
      const project = db.projects.find(p => p.id === b.id);
      ensure(project && project.members.some(m => m.userId === user.id), "Project not found.", 404);
      const owner = project.ownerId === user.id;
      ensure(project.state === "draft", "This project is frozen for editing.", 409);
      if (action === "invite" || action === "cancelInvite") {
        ensure(owner && !project.rosterFrozen, "Only the owner can manage draft invitations.", 403);
        if (action === "cancelInvite") {
          const invitation = db.invitations.find(i => i.id === b.invitation && i.projectId === project.id && !i.accepted && Date.parse(i.expiresAt) > Date.now());
          ensure(invitation, "Invitation not found.", 404);
          invitation.expiresAt = new Date(0).toISOString();
          event(project, `${user.name} canceled a pending invitation.`);
          return json({ ok: true });
        }
        const address = walletAddress(b.address);
        ensure(!project.members.some(member => db.users.find(user => user.id === member.userId)?.address?.toLowerCase() === address.toLowerCase()), "This wallet is already on the team.");
        ensure(!db.invitations.some(invitation => invitation.projectId === project.id && invitation.address?.toLowerCase() === address.toLowerCase() && !invitation.accepted && Date.parse(invitation.expiresAt) > Date.now()), "There is already a pending invitation for this wallet.", 409);
        const invitation = { id: id(), projectId: project.id, address, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), accepted: false };
        db.invitations.push(invitation);
        event(project, `${user.name} created a team invitation.`);
        return json({ token: invitation.id });
      }
      if (["review", "revise", "approve", "revoke", "publish"].includes(String(action))) {
        throw new AppError("Wallet approvals and publishing are not connected to this backend.", 403);
      }
      ensure(action === "save", "Unknown action.");
      ensure(b.revision === project.revision, "This project changed in another session. Reload the latest version before continuing.", 409);
      ensure(Array.isArray(b.panels) && b.panels.length === 4, "A comic needs four panel slots.");
      const panels: Panel[] = [];
      for (const raw of b.panels) {
        ensure(raw && typeof raw === "object" && !Array.isArray(raw), "Invalid panel.");
        panels.push({ image: await validateImage(raw.image), dialogue: text(raw.dialogue, 2000, "Dialogue", false), alt: text(raw.alt, 500, "Image description", false) });
      }
      project.panels = panels;
      if (owner) {
        project.title = text(b.title, 80, "Title");
        project.description = text(b.description, 1000, "Description", false);
        project.terms = text(b.terms, 3000, "Use terms", false);
        const price = text(b.priceWei ?? project.priceWei ?? "0", 78, "Price in wei");
        ensure(/^\d+$/.test(price) && BigInt(price) < BigInt(2) ** BigInt(256), "Price must be an unsigned integer in wei.");
        project.priceWei = price;
        ensure(Array.isArray(b.members) && b.members.length === project.members.length, "The team has changed. Reload first.", 409);
        const candidates = b.members as Record<string, unknown>[];
        ensure(candidates.every(m => m && typeof m === "object") && new Set(candidates.map(m => m.userId)).size === project.members.length, "Invalid team.");
        project.members = project.members.map(member => {
          const candidate = candidates.find(m => m.userId === member.userId);
          ensure(candidate && Number.isInteger(candidate.share) && Number(candidate.share) >= 0 && Number(candidate.share) <= 10000, "Shares must be between 0 and 100% with up to two decimal places.");
          return { ...member, role: text(candidate.role, 60, "Role"), share: Number(candidate.share) };
        });
        ensure(project.members.reduce((sum, member) => sum + member.share, 0) === 10000, "Team shares must total 100%.");
      }
      project.revision++;
      event(project, `${user.name} saved the comic.`);
      return json({ ok: true, id: project.id });
    }, true);
  } catch (error) { return failure(error); }
}
