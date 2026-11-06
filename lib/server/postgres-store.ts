import "server-only";
import { Pool } from "pg";
import type { Database } from "@/lib/store";

const pools = new Map<string, { pool: Pool; schema?: Promise<void> }>();
export function postgresConnection() {
  return process.env.STUDIO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
}
function connection() {
  const url = postgresConnection();
  if (!url) throw new Error("Missing database connection.");
  let entry = pools.get(url);
  if (!entry) {
    entry = { pool: new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, query_timeout: 15000 }) };
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
