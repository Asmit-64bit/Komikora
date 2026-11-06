import { afterEach, describe, expect, it, vi } from "vitest";
import { database } from "@/lib/store";
afterEach(() => vi.unstubAllEnvs());
describe("serverless storage guard", () => {
  it("rejects file storage on Vercel", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("STUDIO_STORAGE", "file");
    await expect(database(() => null)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("persistent PostgreSQL") });
  });
  it("defaults Vercel to durable storage and explains missing configuration", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("STUDIO_STORAGE", "");
    for (const name of ["STUDIO_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"]) vi.stubEnv(name, "");
    await expect(database(() => null)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("connect a persistent PostgreSQL") });
  });
});
