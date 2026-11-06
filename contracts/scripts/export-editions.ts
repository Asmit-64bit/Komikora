import { readFileSync, writeFileSync } from "node:fs";
const artifact = JSON.parse(readFileSync("artifacts/contracts/ConsentCraftEditions.sol/ConsentCraftEditions.json", "utf8"));
const json = JSON.stringify(artifact.abi, null, 2);
writeFileSync("abi/ConsentCraftEditions.json", json + "\n");
writeFileSync("abi/ConsentCraftEditions.ts", `// Generated from ConsentCraftEditions.sol.\nexport const editionsAbi = ${json} as const;\n`);
writeFileSync("../lib/editions-abi.ts", 'export { editionsAbi } from "../contracts/abi/ConsentCraftEditions";\n');
