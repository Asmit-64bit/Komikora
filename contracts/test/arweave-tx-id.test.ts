import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  ARWEAVE_TX_ID_LENGTH,
  InvalidArweaveTxIdError,
  arweaveTxIdToBytes32,
  bytes32ToArweaveTxId,
  isArweaveTxId,
} from "../lib/arweave-tx-id.js";

// Sample transaction IDs copied from the Arweave HTTP API documentation.
const DOC_IDS = [
  "BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ",
  "UEVFNJVXSu7GodYbZoldRHGi_tjzNtNcYjeSkxKCpiE",
  "3pXpj43Tk8QzDAoERjHE3ED7oEKLKephjnVakvkiHF8",
];

const hexOf = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;

describe("Arweave transaction ID <-> bytes32", () => {
  it("round-trips the documented sample IDs", () => {
    for (const id of DOC_IDS) {
      assert.equal(id.length, ARWEAVE_TX_ID_LENGTH);
      const hex = arweaveTxIdToBytes32(id);
      assert.match(hex, /^0x[0-9a-f]{64}$/);
      assert.equal(hex, hexOf(Buffer.from(id, "base64url")));
      assert.equal(bytes32ToArweaveTxId(hex), id);
    }
  });

  it("matches Node's base64url encoding for random SHA-256 digests", () => {
    for (let i = 0; i < 500; i++) {
      const digest = createHash("sha256").update(randomBytes(64)).digest();
      const id = digest.toString("base64url");
      const hex = hexOf(digest);
      assert.equal(isArweaveTxId(id), true);
      assert.equal(bytes32ToArweaveTxId(hex), id);
      assert.equal(arweaveTxIdToBytes32(id), hex);
    }
  });

  it("covers boundary byte values", () => {
    const allFf = `0x${"ff".repeat(32)}`;
    const id = bytes32ToArweaveTxId(allFf);
    assert.equal(id, `${"_".repeat(42)}8`);
    assert.equal(id, Buffer.from(allFf.slice(2), "hex").toString("base64url"));
    assert.equal(arweaveTxIdToBytes32(id), allFf);

    const one = `0x${"00".repeat(31)}01`;
    assert.equal(arweaveTxIdToBytes32(bytes32ToArweaveTxId(one)), one);
  });

  it("accepts uppercase hex and returns lowercase", () => {
    const hex = arweaveTxIdToBytes32(DOC_IDS[0]);
    assert.equal(bytes32ToArweaveTxId(hex.toUpperCase().replace("0X", "0x")), DOC_IDS[0]);
  });

  it("rejects malformed transaction IDs", () => {
    const valid = DOC_IDS[0];
    const bad: unknown[] = [
      "",
      valid.slice(0, 42), // too short
      `${valid}A`, // too long
      `${valid}=`, // padded
      ` ${valid.slice(1)}`, // whitespace
      `${valid.slice(0, 42)}\n`,
      valid.replace("-", "+"), // standard base64 alphabet
      valid.replace("-", "/"),
      valid.replace("B", "."),
      `${valid.slice(0, 42)}B`, // non-canonical trailing bits
      `${valid.slice(0, 42)}R`,
      "A".repeat(43), // decodes to zero bytes
      `0x${"ab".repeat(32)}`, // hex instead of base64url
      "é".repeat(43),
      undefined,
      null,
      42,
    ];
    for (const value of bad) {
      assert.equal(isArweaveTxId(value), false, String(value));
      assert.throws(() => arweaveTxIdToBytes32(value as string), InvalidArweaveTxIdError, String(value));
    }
  });

  it("rejects malformed bytes32 values", () => {
    const bad: unknown[] = [
      "",
      "0x",
      `0x${"00".repeat(32)}`, // zero
      `0x${"ab".repeat(31)}`, // 31 bytes
      `0x${"ab".repeat(33)}`, // 33 bytes
      "ab".repeat(32), // no prefix
      `0x${"zz".repeat(32)}`,
      `0X${"ab".repeat(32)}`,
      ` 0x${"ab".repeat(32)}`,
      undefined,
      123n,
    ];
    for (const value of bad) {
      assert.throws(() => bytes32ToArweaveTxId(value as string), InvalidArweaveTxIdError, String(value));
    }
  });
});
