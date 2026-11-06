import "server-only";
import { AppError, ensure } from "@/lib/store";
import { envValue, NotConfiguredError } from "./env";

export function privateComputerConfigured() { return !!envValue("ZG_COMPUTE_API_KEY"); }
export const DEFAULT_PRIVATE_MODEL = "0gm-1.0-35b-a3b";
export async function privateCompletion(messages: { role: "system" | "user"; content: string | unknown[] }[], maxTokens = 1200) {
  const key = envValue("ZG_COMPUTE_API_KEY");
  if (!key) throw new NotConfiguredError("0G Private Computer", ["ZG_COMPUTE_API_KEY"]);
  const base = new URL(envValue("ZG_COMPUTE_BASE_URL") || "https://router-api.0g.ai/v1");
  ensure(base.protocol === "https:" && !base.username && !base.password, "Use a secure 0G endpoint.", 503);
  const model = envValue("ZG_COMPUTE_MODEL") || DEFAULT_PRIVATE_MODEL;
  const trust = envValue("ZG_COMPUTE_TRUST_MODE") || "private";
  ensure(trust === "private", "Comic review requires private 0G routing. Set ZG_COMPUTE_TRUST_MODE=private.", 503);
  const response = await fetch(`${base.href.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-0G-Provider-Trust-Mode": "private" },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }), signal: AbortSignal.timeout(120000),
  }).catch(() => { throw new AppError("0G Private Computer is unreachable. Retry shortly.", 502); });
  const body = await response.json().catch(() => null) as { id?: string; model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; x_0g_trace?: { request_id?: string; provider?: string }; error?: { code?: string } } | null;
  if (!response.ok || !body) {
    const code = typeof body?.error?.code === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(body.error.code) ? ` (${body.error.code})` : "";
    throw new AppError(response.status === 402 ? "The 0G compute account needs funding." : `0G Private Computer returned HTTP ${response.status}${code}.`, 502);
  }
  const content = body.choices?.[0]?.message?.content;
  ensure(typeof content === "string" && content.length > 0 && content.length < 50000, "0G returned no usable response. Retry or choose another model.", 502);
  const requestId = body.x_0g_trace?.request_id || body.id || response.headers.get("x-request-id");
  ensure(requestId, "0G returned no request ID. The result cannot be recorded.", 502);
  const provider = response.headers.get("x-provider") || body.x_0g_trace?.provider;
  ensure(response.headers.get("x-0g-e2ee") === "sealed" && provider && /^0x[0-9a-fA-F]{40}$/.test(provider), "0G did not return a sealed private result with a provider identity. The score was not accepted.", 502);
  // These are the gateway's checks, not a local DCAP verification. Never infer
  // verification from a missing/non-standard tee_verified flag or routing alone.
  const identity = await fetch(`${base.href.replace(/\/$/, "")}/providers/${provider}/identity`, {
    headers: { Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(15000),
  }).catch(() => { throw new AppError("0G provider verification is unavailable. The score was not accepted.", 502); });
  const evidence = await identity.json().catch(() => null) as { address?: string; verdicts?: Record<string, string>; os_image?: string; compose_hash?: string } | null;
  ensure(identity.ok && evidence?.address?.toLowerCase() === provider.toLowerCase()
    && ["quote_dcap", "onchain_signer", "measurement"].every(k => evidence.verdicts?.[k] === "pass")
    && !["compose_baseline", "runtime_release"].some(k => evidence.verdicts?.[k] === "no_match"),
  "0G did not confirm the provider's attestation, signer and measurements. The score was not accepted.", 502);
  const usage = body.usage;
  ensure(Number.isSafeInteger(usage?.prompt_tokens) && usage!.prompt_tokens! >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage!.completion_tokens! >= 0, "0G returned no valid token usage. The result was not accepted.", 502);
  return { content, requestId, model: body.model || model, inputTokens: body.usage?.prompt_tokens || 0, outputTokens: body.usage?.completion_tokens || 0,
    routerVerified: true, provider, evidence: { verification: "gateway-reported" as const, verdicts: evidence!.verdicts!, osImage: evidence!.os_image, composeHash: evidence!.compose_hash }, at: new Date().toISOString() };
}
