import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { failure, json, rateLimit, readJson } from "@/lib/server/http";
import { integrationReadiness } from "@/lib/server/readiness";
export async function GET() { await connection(); try { return json({ services: await integrationReadiness() }); } catch(e) { return failure(e); } }
export async function POST(req: NextRequest) { try { await readJson(req); rateLimit(req, "connection-checks", 3); return json({ services: await integrationReadiness(true) }); } catch(e) { return failure(e); } }
