import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { recommendEditions } from "@/lib/server/recommendations";
export async function POST(req: NextRequest) {
  try { const body = await readJson(req); rateLimit(req, "curator-suggestions", 5); return json(await recommendEditions(req.cookies.get(SESSION_COOKIE)?.value, body.interests)); }
  catch (error) { return failure(error); }
}
