import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { AppError, ensure } from "@/lib/store";
import { NotConfiguredError, envValue } from "./env";
import { configuredAppOrigin } from "./app-origin";

const headers = { "Cache-Control": "no-store" };
export const json = (body: unknown, status = 200) =>
  NextResponse.json(JSON.parse(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v))), { status, headers });

export function failure(error: unknown) {
  if (!(error instanceof AppError)) console.error("Request failed", error);
  const status = error instanceof AppError ? error.status : 500;
  return json({ error: error instanceof AppError ? error.message : "Something went wrong. Please try again." }, status);
}

/**
 * The single origin this deployment accepts. Sign-in messages name this domain, so a
 * phishing site that relays requests with its own Host header cannot obtain a session.
 */
export function allowedOrigin(req: NextRequest): string {
  const configured = configuredAppOrigin();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") throw new NotConfiguredError("Sign-in", ["APP_ORIGIN"]);
  // Development only: accept the request's own host.
  return `${req.nextUrl.protocol}//${req.headers.get("host")}`;
}

export function checkOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  ensure(origin && origin === allowedOrigin(req), "Request origin is not allowed.", 403);
  return origin;
}

/** Per-IP fixed-window limiter for unauthenticated endpoints (single process). */
const windows = new Map<string, { count: number; reset: number }>();
export function rateLimit(req: NextRequest, bucket: string, limit: number, windowMs = 60_000) {
  limit *= Math.max(1, Number(envValue("RATE_LIMIT_MULTIPLIER") || "1"));
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "local").trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.reset <= now) {
    if (windows.size > 10_000) for (const [k, v] of windows) if (v.reset <= now) windows.delete(k);
    windows.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  entry.count++;
  ensure(entry.count <= limit, "Too many requests. Please wait a minute and try again.", 429);
}

export async function readJson(req: NextRequest, maxBytes = 64_000): Promise<Record<string, unknown>> {
  checkOrigin(req);
  ensure(req.headers.get("content-type")?.split(";")[0].trim() === "application/json", "Send JSON data.", 415);
  const text = await req.text();
  ensure(text.length <= maxBytes, "Request too large.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AppError("Invalid JSON request."); }
  ensure(body && typeof body === "object" && !Array.isArray(body), "Invalid request.");
  return body as Record<string, unknown>;
}
