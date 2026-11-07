import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const state = vi.hoisted(() => ({ bad: false }));
vi.mock("@/lib/server/private-computer", () => ({ privateCompletion: async (_messages: unknown, _tokens: number, model: string) => ({ model, reportedModel: model, provider: `0x${"1".repeat(40)}`, requestId: model, content: JSON.stringify({ score: model === "one" ? 0 : 100, reasons: [], flagged: false }), evidence: { verification: "gateway-reported", verdicts: {} } }) }));
import { juryModels, runJury } from "@/lib/ai-jury";
const saved = process.env.ZG_JURY_MODELS;
afterEach(() => { if (saved === undefined) delete process.env.ZG_JURY_MODELS; else process.env.ZG_JURY_MODELS = saved; state.bad = false; });
describe("multi-model jury", () => {
  it("requires distinct model IDs", () => { process.env.ZG_JURY_MODELS = "one,one"; expect(() => juryModels()).toThrow(/distinct/); });
  it("returns separate model scores including the 0 and 100 boundaries", async () => {
    process.env.ZG_JURY_MODELS = "one,two";
    const pixels = Buffer.from(Array.from({ length: 12 * 12 * 3 }, (_, i) => Math.floor(i / 3) % 2 ? 255 : 0));
    const img = await sharp(pixels, { raw: { width: 12, height: 12, channels: 3 } }).jpeg().toBuffer();
    const pages = Array.from({ length: 4 }, () => ({ mime: "image/jpeg" as const, image: img.toString("base64"), dialogue: "", alt: "" }));
    const results = await runJury(pages); expect(results.map(r => r.verdict.score)).toEqual([0, 100]); expect(results.every(r => r.verification === "gateway-reported")).toBe(true);
  });
  it("rejects blank pages before inference", async () => { process.env.ZG_JURY_MODELS = "one,two"; const img = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).jpeg().toBuffer(); await expect(runJury([{ mime: "image/jpeg", image: img.toString("base64"), dialogue: "", alt: "" }])).rejects.toThrow(/blank/); });
});
