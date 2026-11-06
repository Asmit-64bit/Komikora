import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { ensure } from "@/lib/store";
import { envValue } from "@/lib/server/env";
import { AGENT_PASS_COOKIE, decidePublicationApproval, readPublicationApproval, startPublicationApproval } from "@/lib/server/agent-pass";
export async function GET(req: NextRequest) {
  try { if (req.nextUrl.searchParams.get("view") === "availability") return json({ configured: !!(envValue("WORLD_AGENTPASS_CLIENT_ID") && envValue("WORLD_AGENTPASS_CLIENT_SECRET")), idkit: !!(envValue("NEXT_PUBLIC_WORLD_APP_ID") && envValue("WORLD_RP_ID") && envValue("WORLD_RP_SIGNING_KEY")) }); return json(await readPublicationApproval(req.cookies.get(SESSION_COOKIE)?.value, req.nextUrl.searchParams.get("id") || "")); }
  catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req); rateLimit(req, "agent-pass", 10); const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (body.action === "start") {
      const result = await startPublicationApproval(token, body.projectId, body.enroll === true, body.purpose === "identity");
      const response = NextResponse.json({ id: result.id, url: result.url }, { headers: { "Cache-Control": "no-store" } });
      response.cookies.set(AGENT_PASS_COOKIE, result.binding, { httpOnly: true, secure: req.nextUrl.protocol === "https:", sameSite: "lax", path: "/api/agent-pass/callback", maxAge: 600 });
      return response;
    }
    ensure(body.action === "approve" || body.action === "deny", "Choose approval or denial.");
    return json(await decidePublicationApproval(token, String(body.id || ""), body.action === "approve"));
  } catch (error) { return failure(error); }
}
