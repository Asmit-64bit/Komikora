import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { readComic } from "@/lib/server/reading";
import { failure, json, rateLimit } from "@/lib/server/http";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { rateLimit(req, "comic-reading", 60); return json(await readComic(req.cookies.get(SESSION_COOKIE)?.value, (await params).id)); }
  catch (error) { return failure(error); }
}
