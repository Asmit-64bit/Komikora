import type { NextRequest } from "next/server";
import { isAddress } from "viem";
import { ensure } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { startTeamReview, teamApproval, withdrawTeamApproval, reopenReading, curateReading, prepareReading, confirmReading, readingSnapshot } from "@/lib/server/reading";
export async function GET(req: NextRequest) {
  try {
    const page = Number(req.nextUrl.searchParams.get("page") || 0); ensure(Number.isSafeInteger(page) && page >= 0 && page < 100000, "Invalid page.");
    const wallet = req.nextUrl.searchParams.get("wallet"); ensure(!wallet || isAddress(wallet), "Invalid wallet.");
    return json(await readingSnapshot(wallet ? wallet as `0x${string}` : undefined, page, req.nextUrl.searchParams.get("id") || undefined, req.nextUrl.searchParams.get("library") === "1", req.nextUrl.searchParams.get("credits") === "1"));
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req); rateLimit(req, "reading-publication", 30);
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (body.action === "start") return json(await startTeamReview(token, body));
    if (body.action === "approval") return json(await teamApproval(token, body));
    if (body.action === "approve") return json(await teamApproval(token, body, true));
    if (body.action === "withdraw") return json(await withdrawTeamApproval(token, body.id));
    if (body.action === "reopen") return json(await reopenReading(token, body.id));
    if (body.action === "review") return json(await curateReading(token, body.id));
    if (body.action === "prepare") return json(await prepareReading(token, body.id));
    if (body.action === "confirm") return json(await confirmReading(token, body.id));
    ensure(false, "Unknown action.");
  } catch (error) { return failure(error); }
}
