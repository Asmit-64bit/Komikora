import type { NextRequest } from "next/server";
import { ensure } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { authorizeLegacyPurchase } from "@/lib/server/legacy-authorization";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    rateLimit(req, "legacy-purchase-authorization", 30);
    ensure(body.action === "purchase", "Choose purchase.");
    return json(await authorizeLegacyPurchase(req.cookies.get(SESSION_COOKIE)?.value));
  } catch (error) { return failure(error); }
}
