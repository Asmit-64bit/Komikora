// Releases decrypted pages only to a signed-in wallet with on-chain reading access.
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit } from "@/lib/server/http";
import { readComic } from "@/lib/server/market";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/read/[id]">) {
  try {
    rateLimit(req, "read", 60);
    const { id } = await ctx.params;
    return json(await readComic(req.cookies.get(SESSION_COOKIE)?.value, id));
  } catch (error) { return failure(error); }
}
