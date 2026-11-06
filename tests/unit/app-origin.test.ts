import { describe, expect, it } from "vitest";
import { configuredAppOrigin } from "@/lib/server/app-origin";
describe("deployment origin", () => {
  it("uses the trusted Vercel production hostname when a localhost setting was copied", () => {
    expect(configuredAppOrigin({ VERCEL: "1", VERCEL_ENV: "production", APP_ORIGIN: "http://localhost:3000", VERCEL_PROJECT_PRODUCTION_URL: "creato-phi.vercel.app", VERCEL_URL: "preview.vercel.app" })).toBe("https://creato-phi.vercel.app");
  });
  it("keeps explicit custom domains and uses deployment domains for previews", () => {
    expect(configuredAppOrigin({ VERCEL: "1", APP_ORIGIN: "https://comics.example" })).toBe("https://comics.example");
    expect(configuredAppOrigin({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "preview.vercel.app" })).toBe("https://preview.vercel.app");
  });
  it("does not invent an allowed production origin or trust arbitrary request hosts", () => {
    expect(configuredAppOrigin({ VERCEL: "1", APP_ORIGIN: "http://localhost:3000" })).toBeUndefined();
    expect(configuredAppOrigin({})).toBeUndefined();
    expect(() => configuredAppOrigin({ APP_ORIGIN: "https://user:secret@example.com" })).toThrow();
  });
  it("preserves the configured local development origin", () => {
    expect(configuredAppOrigin({ APP_ORIGIN: "http://localhost:3000" })).toBe("http://localhost:3000");
  });
});
