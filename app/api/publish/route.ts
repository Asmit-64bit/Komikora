// Author publishing steps. The author's own wallet sends every transaction; the
// server only encrypts, stores on Arweave, signs quotes and runs the AI review.
import type { NextRequest } from "next/server";
import { database, ensure, sessionUser } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { cancelPublication, confirmPublication, preparePublication } from "@/lib/server/publishing";
import { scheduleReview } from "@/lib/server/review";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    rateLimit(req, "publish", 20);
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (body.action === "prepare") return json(await preparePublication(token, body));
    if (body.action === "confirm") return json(await confirmPublication(token, body));
    if (body.action === "cancel") return json(await cancelPublication(token, body));
    ensure(body.action === "retryReview", "Unknown action.");
    const projectId = await database(db => {
      const user = sessionUser(db, token);
      ensure(user, "Sign in first.", 401);
      const project = db.projects.find(p => p.id === body.id && p.ownerId === user.id);
      ensure(project?.publication?.publicationId, "Publication not found.", 404);
      ensure(project.publication.status === "review_failed" || project.publication.status === "created", "The review is not waiting for a retry.", 409);
      return project.id;
    });
    void scheduleReview(projectId);
    return json({ ok: true });
  } catch (error) { return failure(error); }
}
