/**
 * Arweave transaction ID <-> bytes32 conversion.
 *
 * An Arweave transaction ID is the SHA-256 hash of the transaction signature,
 * serialized as an unpadded Base64URL string (RFC 4648 §5). A 32-byte digest
 * encodes to exactly 43 characters. 43 characters carry 258 bits, so the two
 * low bits of the final character must be zero for the encoding to be
 * canonical. Non-canonical strings decode to the same bytes as a canonical
 * one; they are rejected so every bytes32 maps back to exactly one ID.
 *
 * Reference: https://docs.arweave.org/developers/arweave-node-server/http-api
 * (transaction field `id`: "Base64URL string", "A SHA-256 hash of the
 * transaction signature"; Base64URL is case-sensitive).
 *
 * Pure TypeScript with no Node-only APIs, so it can run in the backend,
 * scripts, tests and the browser.
 */

export type Bytes32Hex = `0x${string}`;

export const ARWEAVE_TX_ID_LENGTH = 43;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TX_ID_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const ZERO_TX_ID = "A".repeat(43);

const DECODE = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export class InvalidArweaveTxIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArweaveTxIdError";
  }
}

/** True when `value` is a canonical, non-zero 43-character Base64URL Arweave transaction ID. */
export function isArweaveTxId(value: unknown): value is string {
  return typeof value === "string" && TX_ID_PATTERN.test(value) && value !== ZERO_TX_ID;
}

/**
 * Converts a canonical Arweave transaction ID to a lowercase bytes32 hex string.
 * Throws InvalidArweaveTxIdError for anything else, including padded,
 * standard-Base64 (+ /), whitespace-wrapped, wrong-length or non-canonical input.
 * The all-zero ID is rejected because the contract treats zero as "unset".
 */
export function arweaveTxIdToBytes32(txId: string): Bytes32Hex {
  if (typeof txId !== "string") {
    throw new InvalidArweaveTxIdError("Arweave transaction ID must be a string");
  }
  if (txId.length !== ARWEAVE_TX_ID_LENGTH) {
    throw new InvalidArweaveTxIdError(
      `Arweave transaction ID must be ${ARWEAVE_TX_ID_LENGTH} characters, got ${txId.length}`,
    );
  }
  if (!TX_ID_PATTERN.test(txId)) {
    throw new InvalidArweaveTxIdError(
      "Arweave transaction ID must be canonical unpadded Base64URL (A-Z a-z 0-9 - _)",
    );
  }

  let hex = "";
  let buffer = 0;
  let bits = 0;
  for (const char of txId) {
    buffer = ((buffer << 6) | (DECODE.get(char) as number)) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((buffer >> bits) & 0xff).toString(16).padStart(2, "0");
    }
  }
  // 258 bits read, 256 emitted; the 2 leftover bits are zero (enforced by the pattern).

  const result = `0x${hex}` as Bytes32Hex;
  if (result === ZERO_BYTES32) {
    throw new InvalidArweaveTxIdError("Arweave transaction ID must not be all zero bytes");
  }
  return result;
}

/**
 * Converts a bytes32 hex string back to its canonical Arweave transaction ID.
 * Accepts either hex case. Rejects wrong lengths, missing 0x and the zero value.
 */
export function bytes32ToArweaveTxId(value: string): string {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    throw new InvalidArweaveTxIdError("Value must be a 0x-prefixed 32-byte hex string");
  }
  if (value.toLowerCase() === ZERO_BYTES32) {
    throw new InvalidArweaveTxIdError("Zero bytes32 is not an Arweave transaction ID");
  }

  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 2; i < value.length; i += 2) {
    buffer = ((buffer << 8) | parseInt(value.slice(i, i + 2), 16)) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(buffer >> bits) & 0x3f];
    }
  }
  out += ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return out;
}
