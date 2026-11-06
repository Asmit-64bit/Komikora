import { afterEach, describe, expect, it, vi } from "vitest";
import { database } from "@/lib/store";
import { postgresConfigurationError, postgresPoolOptions } from "@/lib/server/postgres-store";
import { Pool } from "pg";
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
  it.each(["localhost", "127.0.0.1", "[::1]", "postgres", "db", "host.docker.internal"])("rejects the development database host %s on Vercel without disclosing credentials", async host => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("STUDIO_STORAGE", "postgres");
    vi.stubEnv("STUDIO_DATABASE_URL", `postgresql://private-user:private-password@${host}:5432/private-db`);
    await expect(database(() => null)).rejects.toMatchObject({ status: 503, message: "This deployment points to a local database. Connect a hosted PostgreSQL database and redeploy." });
  });
  it("validates URL syntax and honors the dedicated hosted studio connection", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://local:secret@localhost/studio");
    vi.stubEnv("STUDIO_DATABASE_URL", "not-a-connection");
    expect(postgresConfigurationError()).toBe("The studio database connection must be a valid PostgreSQL URL.");
    vi.stubEnv("STUDIO_DATABASE_URL", "https://example.test/database");
    expect(postgresConfigurationError()).toBe("The studio database connection must be a valid PostgreSQL URL.");
    vi.stubEnv("STUDIO_DATABASE_URL", "postgresql://server:secret@pooler.example.test/studio?sslmode=require");
    expect(postgresConfigurationError()).toBeUndefined();
  });
  it("keeps a local PostgreSQL connection available outside Vercel", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STUDIO_DATABASE_URL", "postgresql://local:secret@localhost/studio");
    expect(postgresConfigurationError()).toBeUndefined();
  });
  it("preserves CA and hostname verification when a provider URL contains sslmode=require", async () => {
    vi.stubEnv("STUDIO_DATABASE_CA_CERT", "provider-root\\ncertificate");
    const options = postgresPoolOptions("postgresql://server:secret@pooler.example.test/studio?sslmode=require");
    const pool = new Pool(options);
    expect(pool.options.ssl).toEqual({ ca: "provider-root\ncertificate", rejectUnauthorized: true });
    expect(new URL(options.connectionString!).searchParams.has("sslmode")).toBe(false);
    await pool.end();
  });
});
