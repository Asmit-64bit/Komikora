import { readFileSync, writeFileSync } from "node:fs";
const artifact = JSON.parse(readFileSync("artifacts/contracts/ConsentCraftReading.sol/ConsentCraftReading.json", "utf8"));
writeFileSync("abi/ConsentCraftReading.json", JSON.stringify(artifact.abi, null, 2) + "\n");
writeFileSync("../lib/reading-abi.ts", "// Generated from ConsentCraftReading.sol.\nexport const readingAbi = " + JSON.stringify(artifact.abi, null, 2) + " as const;\n");
