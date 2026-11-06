import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { parseEther } from "viem";

let zg: typeof import("@/lib/server/zg");
beforeAll(async () => {
  for (const k of ["ZG_PRIVATE_KEY", "ZG_PROVIDER_ADDRESS", "ZG_ETH_PER_0G"]) delete process.env[k];
  zg = await import("@/lib/server/zg");
});

const page = async (noise: boolean) => {
  const img = noise
    ? sharp(Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 37) % 256)), { raw: { width: 32, height: 32, channels: 3 } })
    : sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } });
  return { mime: "image/jpeg" as const, image: (await img.jpeg().toBuffer()).toString("base64"), dialogue: "", alt: "" };
};

describe("0G screening", () => {
  it("converts 0G token cost to wei, rounding up", () => {
    // 1 0G = 0.0004 ETH, so 2,500 neuron is exactly 1 wei and 2,501 neuron (1.0004 wei) rounds up to 2.
    expect(zg.neuronToWei(BigInt(2500), parseEther("0.0004"))).toBe(BigInt(1));
    expect(zg.neuronToWei(BigInt(2501), parseEther("0.0004"))).toBe(BigInt(2));
    expect(zg.neuronToWei(parseEther("1"), parseEther("0.0004"))).toBe(parseEther("0.0004"));
    expect(zg.neuronToWei(BigInt(0), parseEther("0.0004"))).toBe(BigInt(0));
  });

  it("accepts only a strict JSON verdict", () => {
    expect(zg.parseVerdict('```json\n{"flagged": false, "score": 72, "categories": [], "reasons": ["clean"]}\n```')).toMatchObject({ flagged: false, score: 72 });
    expect(() => zg.parseVerdict("looks fine to me")).toThrow(/did not return a JSON verdict/);
    expect(() => zg.parseVerdict('{"flagged": "no", "score": 72, "reasons": []}')).toThrow(/malformed/);
    expect(() => zg.parseVerdict('{"flagged": false, "score": 720, "reasons": []}')).toThrow(/malformed/);
    expect(() => zg.parseVerdict('{"flagged": false, "score": 70, "reasons": [], "approve": true}')).toThrow(/malformed/);
  });

  it("flags blank pages for free, without calling 0G", async () => {
    const result = await zg.screenWith0G([await page(true), await page(false)]);
    expect(result).toMatchObject({ flagged: true, provider: "deterministic", costWei: "0", inputTokens: 0 });
    expect(result.reasons[0]).toMatch(/Page 2 is blank/);
  });

  it("never returns a result when 0G is not configured", async () => {
    await expect(zg.screenWith0G([await page(true)])).rejects.toThrow(/0G AI review is not configured/);
  });
});
