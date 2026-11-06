// Appeal evidence and reviewer reasons stay private here. The contract only ever
// receives keccak256(salt, text), so the text can later be proven without publishing it.
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { keccak256, toHex } from "viem";
import { database, ensure, sessionUser, text } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { getPublication, hasRole } from "@/lib/server/chain";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";

const salted = (value: string) => {
  const salt = randomBytes(32).toString("hex");
  return { text: value, salt, hash: keccak256(toHex(`${salt}\n${value}`)), at: new Date().toISOString() };
};

async function viewer(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = await database(db => sessionUser(db, token));
  ensure(user, "Sign in first.", 401);
  return user;
}

export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("publicationId") ?? "";
    ensure(/^\d{1,30}$/.test(id), "Invalid publication.");
    const user = await viewer(req);
    const publication = await getPublication(BigInt(id));
    const isAuthor = publication.author.toLowerCase() === user.address.toLowerCase();
    ensure(isAuthor || await hasRole("REVIEWER_ROLE", user.address), "Only the author or a reviewer can read this appeal.", 403);
    return json(await database(db => db.appealNotes?.[id] ?? {}));
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    rateLimit(req, "appeal", 20);
    const id = String(body.publicationId ?? "");
    ensure(/^\d{1,30}$/.test(id), "Invalid publication.");
    const user = await viewer(req);
    const publication = await getPublication(BigInt(id));
    if (body.kind === "evidence") {
      ensure(publication.author.toLowerCase() === user.address.toLowerCase(), "Only the author can appeal.", 403);
      const note = salted(text(body.text, 4000, "Appeal evidence"));
      await database(db => { db.appealNotes ??= {}; db.appealNotes[id] = { ...db.appealNotes[id], evidence: note }; }, true);
      return json({ hash: note.hash });
    }
    ensure(body.kind === "reason", "Unknown kind.");
    ensure(await hasRole("REVIEWER_ROLE", user.address), "Only a reviewer can record a decision reason.", 403);
    const note = salted(text(body.text, 4000, "Decision reason"));
    await database(db => { db.appealNotes ??= {}; db.appealNotes[id] = { ...db.appealNotes[id], reason: note }; }, true);
    return json({ hash: note.hash });
  } catch (error) { return failure(error); }
}
