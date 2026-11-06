// Opt-in paid integration check. Uses generated comic art, never user documents.
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { screenWith0G } from "@/lib/server/zg";
import { integrationReadiness } from "@/lib/server/readiness";
describe.skipIf(process.env.LIVE_0G !== "1")("live 0G visual curator", () => {
  it("checks private model metadata without submitting content", async () => {
    const service = (await integrationReadiness(true)).find(s => s.name === "0G Private Computer");
    expect(service?.detail).toMatch(/Private provider available/);
  }, 40000);
  it("reviews an actual image through the configured Private Computer key", async () => {
    const art = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="#fff8df"/><rect x="10" y="10" width="280" height="300" fill="#d7c5ed" stroke="black" stroke-width="4"/><rect x="310" y="10" width="280" height="300" fill="#bde3d0" stroke="black" stroke-width="4"/><circle cx="140" cy="150" r="45" fill="#ffcf75" stroke="black"/><path d="M140 195v70m0-40l-45 25m45-25l45 25" stroke="black" stroke-width="6"/><rect x="40" y="30" width="200" height="50" fill="white" stroke="black"/><text x="70" y="63" font-size="25">Hello, friend!</text><circle cx="450" cy="150" r="45" fill="#ffcf75" stroke="black"/><path d="M450 195v70m0-40l-45 25m45-25l45 25" stroke="black" stroke-width="6"/><rect x="340" y="30" width="230" height="50" fill="white" stroke="black"/><text x="365" y="63" font-size="25">Let us draw!</text></svg>');
    const image = (await sharp(art).jpeg().toBuffer()).toString("base64");
    const result = await screenWith0G([{ mime: "image/jpeg", image, dialogue: "", alt: "Synthetic two-panel greeting comic" }], { usePrivateComputer: true });
    expect(result.provider).toBe("0G Private Computer"); expect(result.chatId).toBeTruthy(); expect(result.inputTokens).toBeGreaterThan(0); expect(result.reasons).toBeInstanceOf(Array);
    console.log(JSON.stringify({ liveVisualRequest: result.chatId, model: result.model, score: result.score, flagged: result.flagged, verification: result.verification, inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
  }, 150000);
});
