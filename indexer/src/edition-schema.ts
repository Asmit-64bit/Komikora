// Shared public schema. Reading keys, private pages, proofs and appeal text never enter this index.
import { addr, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema";
export const EditionIndex = defineSchema("consentcraft.editions.v1", {
  recordId: key().indexed(), chainId: u64().indexed(), contract: addr().indexed(),
  kind: str().indexed(), tokenId: u64().indexed(), phase: str().indexed(), creator: addr().indexed(),
  title: str(), genre: str().indexed(), payload: str(), contentHash: key(), sourceBlock: u64(),
});
