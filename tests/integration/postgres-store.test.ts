// Opt-in real database check. Writes only one isolated, temporary namespace.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgresPoolOptions } from "@/lib/server/postgres-store";
describe.skipIf(!process.env.TEST_STUDIO_DATABASE_URL)("persistent studio transactions", () => {
  const namespace = `postgres-test-${randomUUID()}`;
  let sql: Pool;
  beforeAll(() => { vi.stubEnv("STUDIO_DATABASE_URL", process.env.TEST_STUDIO_DATABASE_URL!); sql = new Pool({ ...postgresPoolOptions(process.env.TEST_STUDIO_DATABASE_URL!), connectionTimeoutMillis: 5000 }); });
  afterAll(async () => { await sql.query("DELETE FROM consentcraft_studio_state WHERE namespace = $1", [namespace]); await sql.end(); vi.unstubAllEnvs(); });
  it("persists across instances, serializes concurrent writes and rolls back failures", async () => {
    const first = await import("@/lib/server/postgres-store");
    await first.postgresDatabase(namespace, db => { db.users.push({ id: "initial", name: "Fixture", color: "purple" }); }, true);
    const privacy = await sql.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'consentcraft_studio_state'::regclass");
    expect(privacy.rows[0].relrowsecurity).toBe(true);
    vi.resetModules(); const second = await import("@/lib/server/postgres-store");
    expect(await second.postgresDatabase(namespace, db => db.users.length, false)).toBe(1);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).postgresDatabase(namespace, async db => {
      const old = db.users.length; await new Promise(r => setTimeout(r, 5));
      db.users.push({ id: `writer-${old}`, name: "Concurrent fixture", color: "purple" });
    }, true)));
    expect(await first.postgresDatabase(namespace, db => new Set(db.users.map(u => u.id)).size, false)).toBe(13);
    await expect(second.postgresDatabase(namespace, db => { db.users.length = 0; throw new Error("rollback fixture"); }, true)).rejects.toThrow("rollback fixture");
    expect(await first.postgresDatabase(namespace, db => db.users.length, false)).toBe(13);
    await second.postgresDatabase(namespace, db => { db.users.length = 0; }, false);
    expect(await first.postgresDatabase(namespace, db => db.users.length, false)).toBe(13);
  }, 20000);
});
