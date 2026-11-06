import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { privateCompletion } from "@/lib/server/private-computer";
const provider = `0x${"11".repeat(20)}`;
let sealed = true; let verdict = "pass"; let status = 200;
const fetchMock = vi.fn(async (input: string | URL | Request, _options?: RequestInit) => {
  void _options;
  if (String(input).endsWith("/identity")) return Response.json({ address: provider, verdicts: { quote_dcap: verdict, measurement: "pass", onchain_signer: "pass" }, os_image: "fixture-os" });
  return Response.json(status === 200 ? { id: "chat-one", x_0g_trace: { provider, request_id: "private-request" }, choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } } : { error: { code: "no_provider_for_trust_mode", message: "private secret" } }, { status, headers: sealed ? { "x-0g-e2ee": "sealed", "x-provider": provider } : {} });
});
beforeEach(() => {
  vi.stubEnv("ZG_COMPUTE_API_KEY", "fixture-key"); vi.stubEnv("ZG_COMPUTE_BASE_URL", "https://router-api.0g.ai/v1"); vi.stubEnv("ZG_COMPUTE_MODEL", ""); vi.stubEnv("ZG_COMPUTE_TRUST_MODE", "private");
  sealed = true; verdict = "pass"; status = 200; fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("private scoring transport", () => {
  it("requires sealed private output and records gateway-reported evidence", async () => {
    const result = await privateCompletion([{ role: "user", content: "test" }]);
    expect(result.requestId).toBe("private-request"); expect(result.evidence.verification).toBe("gateway-reported");
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({ "X-0G-Provider-Trust-Mode": "private" });
    expect(JSON.parse(String(options.body)).model).toBe("0gm-1.0-35b-a3b");
  });
  it("rejects standard routing before submitting any content", async () => {
    vi.stubEnv("ZG_COMPUTE_TRUST_MODE", "standard");
    await expect(privateCompletion([])).rejects.toThrow(/requires private/); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects unsealed output and failed provider checks", async () => {
    sealed = false; await expect(privateCompletion([])).rejects.toThrow(/sealed/);
    sealed = true; verdict = "no_match"; await expect(privateCompletion([])).rejects.toThrow(/attestation/);
  });
  it("does not retry on standard routing or expose raw provider errors", async () => {
    status = 503; await expect(privateCompletion([])).rejects.toThrow("HTTP 503 (no_provider_for_trust_mode)"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("requires the configured credential", async () => {
    vi.stubEnv("ZG_COMPUTE_API_KEY", ""); await expect(privateCompletion([])).rejects.toThrow(/ZG_COMPUTE_API_KEY/); expect(fetchMock).not.toHaveBeenCalled();
  });
});
