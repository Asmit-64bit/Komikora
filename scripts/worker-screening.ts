import { keccak256, toHex } from "viem";
import { executeScreeningPipeline, get0GRouterClient } from "../lib/ai-screening.js";
import type { Panel } from "../lib/types.js";

async function main() {
  console.log("=== ConsentCraft 0G Multimodal Screening Worker ===");
  const { model, isMock } = get0GRouterClient();
  console.log(`Provider: 0G Compute Router (${isMock ? "Mock / Offline Mode" : "Live Endpoint"})`);
  console.log(`Model:    ${model}`);

  // Fixture: sample 4-panel comic with solid/blank and gradient test panels
  const samplePanels: Panel[] = [
    {
      image: "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString("base64"),
      dialogue: "Where are we going?",
      alt: "Panel 1",
    },
    {
      image: "",
      dialogue: "Into the unknown...",
      alt: "Panel 2",
    },
    {
      image: "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString("base64"),
      dialogue: "Look at the horizon!",
      alt: "Panel 3",
    },
    {
      image: "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString("base64"),
      dialogue: "Together, we craft.",
      alt: "Panel 4",
    },
  ];

  console.log("\nRunning screening pipeline on test submission...");
  const result = await executeScreeningPipeline({
    publicationId: BigInt(1),
    manifestHash: keccak256(toHex("sample-publication-manifest")),
    arweaveBundleTxId: keccak256(toHex("sample-arweave-bundle")),
    panels: samplePanels,
  });

  console.log("\nScreening Results:");
  console.log(`- Technical Validity: ${result.screening.technicalValidity ? "PASS" : "FAIL"}`);
  console.log(`- Advisory Score:     ${result.screening.score}/100 (Scaled uint16: ${result.report.score})`);
  console.log(`- Flagged:            ${result.screening.flagged ? "YES" : "NO"}`);
  console.log(`- Reasons:            ${result.screening.reasons.join("; ")}`);
  console.log(`- Model Version Hash: ${result.report.modelVersion}`);
  console.log(`- Prompt Version Hash:${result.report.promptVersion}`);
  console.log(`- Job ID:             ${result.report.jobId}`);
  console.log(`- Signature:          ${result.signature ? "Signed by REPORTER_ROLE" : "Not signed (no REPORTER_PRIVATE_KEY set)"}`);

  console.log("\n0G worker pipeline test complete.");
}

main().catch((err) => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
