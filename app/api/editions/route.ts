import type { NextRequest } from "next/server";
import { isAddress } from "viem";
import { database, ensure, id, sessionUser, text } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { confirmEdition, editionAppeal, moderationQueue, prepareEdition, reopenEdition } from "@/lib/server/editions";
import { editionSnapshot } from "@/lib/server/nft-snapshot";
import { confirmedNFT } from "@/lib/server/nft-chain";
export async function GET(req: NextRequest) {
  try {
    const user = await database(db => sessionUser(db, req.cookies.get(SESSION_COOKIE)?.value));
    if (req.nextUrl.searchParams.get("view") === "moderation") { ensure(user, "Sign in first.", 401); return json(await moderationQueue(user)); }
    const page = Number(req.nextUrl.searchParams.get("page") || 0); ensure(Number.isSafeInteger(page) && page >= 0 && page < 100000, "Invalid page.");
    const wallet = req.nextUrl.searchParams.get("wallet"); ensure(!wallet || isAddress(wallet), "Invalid wallet.");
    if (req.nextUrl.searchParams.get("view") === "token") {
      const id = req.nextUrl.searchParams.get("id") || ""; ensure(/^\d{1,30}$/.test(id), "Invalid edition.");
      return json(await editionSnapshot(0, "token", wallet ? wallet as `0x${string}` : undefined, undefined, BigInt(id)));
    }
    if (req.nextUrl.searchParams.get("view") === "access") {
      if (!wallet) return json({ unlocked: false });
      const cfg = await confirmedNFT();
      return json({ unlocked: await cfg.client.readContract({ ...cfg, functionName: "canTrade", args: [wallet as `0x${string}`] }) });
    }
    return json(await editionSnapshot(page, req.nextUrl.searchParams.get("view") || "primary", wallet ? wallet as `0x${string}` : undefined, req.nextUrl.searchParams.get("genre")?.slice(0,60)));
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req); rateLimit(req, "editions", 20);
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (body.action === "prepare") return json(await prepareEdition(token, body));
    if (body.action === "review") return json(await prepareEdition(token, { ...body, reviewOnly: true }));
    if (body.action === "confirm") return json(await confirmEdition(token, body.id));
    if (body.action === "reopen") return json(await reopenEdition(token, body.id));
    if (body.action === "appeal" || body.action === "resolve") return json(await editionAppeal(token, body));
    const user = await database(db => sessionUser(db, token)); ensure(user, "Sign in first.", 401);
    if (body.action === "report") {
      ensure(/^\d{1,30}$/.test(String(body.comicId)), "Invalid comic.");
      const report = { id: id(), comicId: String(body.comicId), userId: user.id, text: text(body.text, 4000, "Report"), at: new Date().toISOString(), status: "open" as const };
      await database(db => { db.abuseReports ??= []; ensure(db.abuseReports.filter(r => r.userId === user.id && Date.parse(r.at) > Date.now() - 86400000).length < 10, "Daily report limit reached.", 429); db.abuseReports.push(report); }, true);
      return json({ id: report.id });
    }
    ensure(body.action === "resolveReport", "Unknown action."); await moderationQueue(user);
    await database(db => { const report = db.abuseReports?.find(r => r.id === body.id); ensure(report, "Report not found.", 404); report.status = "resolved"; report.response = text(body.text, 2000, "Response"); }, true);
    return json({ ok: true });
  } catch (error) { return failure(error); }
}
