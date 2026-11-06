import { NextResponse, type NextRequest } from "next/server";
import { AGENT_PASS_COOKIE, finishPublicationApproval } from "@/lib/server/agent-pass";
export async function GET(req: NextRequest) {
  try {
    const id = await finishPublicationApproval(req.nextUrl.searchParams, req.cookies.get(AGENT_PASS_COOKIE)?.value);
    const response = NextResponse.redirect(new URL(`/approval/${id}`, req.nextUrl.origin), 303);
    response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(AGENT_PASS_COOKIE, "", { path: "/api/agent-pass/callback", maxAge: 0 }); return response;
  } catch { return NextResponse.redirect(new URL("/network?approval=failed", req.nextUrl.origin), 303); }
}
