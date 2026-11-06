import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("loads the upload SDK when CommonJS cannot synchronously require ESM, as on Vercel", () => {
  const result = spawnSync(process.execPath, [
    "--no-experimental-require-module", "--input-type=module", "-e",
    "const { TurboFactory } = await import('@ardrive/turbo-sdk'); if (typeof TurboFactory.authenticated !== 'function') throw new Error('Upload SDK unavailable');",
  ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
}, 25_000);
