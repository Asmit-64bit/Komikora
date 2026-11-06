import "server-only";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "@/lib/store";

const pools = new Map<string, { pool: Pool; schema?: Promise<void> }>();
export function postgresConnection() {
  return process.env.STUDIO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
}
export function postgresConfigurationError() {
  const value = postgresConnection();
  if (!value) return "Sign-in is unavailable: the studio operator must connect a persistent PostgreSQL database.";
  let url: URL;
  try { url = new URL(value); }
  catch { return "The studio database connection must be a valid PostgreSQL URL."; }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
    return "The studio database connection must be a valid PostgreSQL URL.";
  if (process.env.VERCEL === "1" && (/^127\./.test(url.hostname) || ["localhost", "[::1]", "0.0.0.0", "postgres", "db", "host.docker.internal"].includes(url.hostname) || url.hostname.endsWith(".localhost")))
    return "This deployment points to a local database. Connect a hosted PostgreSQL database and redeploy.";
}
export function postgresPoolOptions(value: string): PoolConfig {
  const ca = process.env.STUDIO_DATABASE_CA_CERT?.trim();
  if (!ca) return { connectionString: value };
  const url = new URL(value);
  // pg replaces an explicit SSL object when these URL options are present.
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
  return { connectionString: url.href, ssl: { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true } };
}
function connection() {
  const url = postgresConnection();
  if (!url) throw new Error("Missing database connection.");
  let entry = pools.get(url);
  if (!entry) {
    entry = { pool: new Pool({ ...postgresPoolOptions(url), max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, query_timeout: 15000 }) };
    // Idle connection failures must not crash a serverless instance or log credentials.
    entry.pool.on("error", () => {});
    pools.set(url, entry);
  }
  return entry;
}
async function initialize(entry: ReturnType<typeof connection>) {
  entry.schema ??= (async () => {
    const client = await entry.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(681302491)");
      await client.query("CREATE TABLE IF NOT EXISTS consentcraft_studio_state (namespace text PRIMARY KEY, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
      // Supabase exposes public-schema tables through its Data API. No policies:
      // browser roles cannot read sessions or keys; the server uses the table owner.
      await client.query("ALTER TABLE consentcraft_studio_state ENABLE ROW LEVEL SECURITY");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  })().catch(error => { entry.schema = undefined; throw error; });
  await entry.schema;
}
export async function postgresDatabase<T>(namespace: string, fn: (db: Database) => T | Promise<T>, write: boolean): Promise<T> {
  const entry = connection(); await initialize(entry);
  const client = await entry.pool.connect();
  try {
    await client.query("BEGIN");
    const empty = { users: [], sessions: [], projects: [], invitations: [] };
    if (write) await client.query("INSERT INTO consentcraft_studio_state(namespace, document) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING", [namespace, JSON.stringify(empty)]);
    const row = await client.query<{ document: Database }>(`SELECT document FROM consentcraft_studio_state WHERE namespace = $1${write ? " FOR UPDATE" : ""}`, [namespace]);
    const db = row.rows[0]?.document || empty;
    const result = await fn(db);
    if (write) await client.query("UPDATE consentcraft_studio_state SET document = $2::jsonb, updated_at = now() WHERE namespace = $1", [namespace, JSON.stringify(db)]);
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
