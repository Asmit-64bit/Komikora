import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import {
  runDeterministicChecks,
  screenComicWith0G,
  executeScreeningPipeline,
  get0GRouterClient,
  SCREENING_PROMPT_VERSION,
} from "@/lib/ai-screening";
import type { Panel } from "@/lib/types";

describe("0G Multimodal Screening Pipeline", () => {
  it("detects missing or empty panel images deterministically", async () => {
    const invalidPanels: Panel[] = [
      { image: "", dialogue: "Empty image", alt: "Panel 1" },
      { image: "", dialogue: "Empty image", alt: "Panel 2" },
      { image: "", dialogue: "Empty image", alt: "Panel 3" },
      { image: "", dialogue: "Empty image", alt: "Panel 4" },
    ];

    const result = await runDeterministicChecks(invalidPanels);
    expect(result.passed).toBe(false);
    expect(result.flags.length).toBeGreaterThanOrEqual(4);
    expect(result.flags[0]).toContain("Image is empty or missing");
  });

  it("checks 0G client configuration", () => {
    const { model, isMock } = get0GRouterClient();
    expect(model).toBeDefined();
    expect(typeof isMock).toBe("boolean");
  });

  it("screens comic panels and flags fatal defects", async () => {
    const panelsWithEmpty: Panel[] = [
      { image: "", dialogue: "P1", alt: "" },
      { image: "", dialogue: "P2", alt: "" },
      { image: "", dialogue: "P3", alt: "" },
      { image: "", dialogue: "P4", alt: "" },
    ];

    const report = await screenComicWith0G(panelsWithEmpty, "Test Submission");
    expect(report.technicalValidity).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.promptVersion).toBe(SCREENING_PROMPT_VERSION);
    expect(report.score).toBeLessThanOrEqual(50);
  });

  it("executes full screening pipeline and produces cryptographic ReviewReport", async () => {
    const dummyPanels: Panel[] = [
      { image: "", dialogue: "Panel 1", alt: "" },
      { image: "", dialogue: "Panel 2", alt: "" },
      { image: "", dialogue: "Panel 3", alt: "" },
      { image: "", dialogue: "Panel 4", alt: "" },
    ];

    const manifestHash = keccak256(toHex("sample-manifest"));
    const arweaveBundleTxId = keccak256(toHex("sample-arweave-tx"));

    const { screening, report } = await executeScreeningPipeline({
      publicationId: BigInt(42),
      manifestHash,
      arweaveBundleTxId,
      panels: dummyPanels,
    });

    expect(screening).toBeDefined();
    expect(report.publicationId).toBe(BigInt(42));
    expect(report.manifestHash).toBe(manifestHash);
    expect(report.arweaveBundleTxId).toBe(arweaveBundleTxId);
    expect(report.reportHash.startsWith("0x")).toBe(true);
    expect(report.modelVersion.startsWith("0x")).toBe(true);
    expect(report.promptVersion.startsWith("0x")).toBe(true);
    expect(report.jobId.startsWith("0x")).toBe(true);
    expect(report.aiCost).toBeGreaterThan(BigInt(0));
  });
});
