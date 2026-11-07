import { keccak256, toHex } from "viem";
import type { OriginalityResult } from "./types";
export const ORIGINALITY_VERSION = "consentcraft-originality-v2";
export const ORIGINALITY_THRESHOLD = 85;
export function catalogueHash(chainId: number, contract: string, entries: { id: string; key: string; manifestHash: string }[]) {
  return keccak256(toHex(JSON.stringify({ chainId, contract: contract.toLowerCase(), entries })));
}
export function originalityId(result: OriginalityResult) { return keccak256(toHex(JSON.stringify(result))); }
/** Public findings omit the private plot synopsis and never include content keys. */
export function publicOriginality(result: OriginalityResult) {
  const { crux: _privateSynopsis, ...findings } = result;
  void _privateSynopsis;
  return findings;
}
