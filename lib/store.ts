import "server-only";
// Adapted from Asmit-64bit/consentcraft's local studio store.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { User, Project, Invitation } from "./types";

export type Account = User & { password: string; salt: string };
export type Database = {
  users: Account[];
  sessions: { token: string; userId: string; expires: number }[];
  projects: Project[];
  invitations: Invitation[];
};

const namespace = process.env.CONSENTCRAFT_DATA_NAMESPACE || "studio";
if (!/^[a-zA-Z0-9_-]{1,100}$/.test(namespace)) throw new Error("Invalid studio data namespace.");
export const storageRoot = path.join(process.cwd(), ".data", namespace);
const file = path.join(storageRoot, "studio.json");
const globalStore = globalThis as typeof globalThis & { consentStudioLock?: Promise<unknown> };

// Serialize read-modify-write operations within this Node process. Each successful
// mutation is atomically renamed into place; a failed mutation writes nothing.
export async function database<T>(fn: (db: Database) => T | Promise<T>, write = false): Promise<T> {
  const work = (globalStore.consentStudioLock || Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(storageRoot, { recursive: true });
    let db: Database;
    try { db = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      db = { users: [], sessions: [], projects: [], invitations: [] };
    }
    const result = await fn(db);
    if (write) {
      const temporary = `${file}.${id()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(db), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    return result;
  });
  globalStore.consentStudioLock = work;
  return work;
}

export function id() { return randomBytes(32).toString("hex"); }
const deriveKey = promisify(scrypt);
export async function hash(password: string, salt: string) {
  return (await deriveKey(password, salt, 64) as Buffer).toString("hex");
}
export async function passwordMatches(password: string, account?: Account) {
  // Perform the same expensive operation for an unknown account.
  const candidate = Buffer.from(await hash(password, account?.salt || "unknown-account"), "hex");
  const expected = account ? Buffer.from(account.password, "hex") : Buffer.alloc(64);
  return expected.length === candidate.length && timingSafeEqual(candidate, expected) && !!account;
}
export function publicUser(account: Account): User {
  return { id: account.id, name: account.name, email: account.email, color: account.color };
}
export function sessionUser(db: Database, token?: string) {
  const session = token && db.sessions.find(s => s.token === token && s.expires > Date.now());
  return session ? db.users.find(u => u.id === session.userId) : undefined;
}
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function ensure(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new AppError(message, status);
}
export function text(value: unknown, max: number, label: string, required = true) {
  ensure(typeof value === "string", `${label} must be text.`);
  const clean = value.trim();
  ensure((!required || clean.length > 0) && clean.length <= max, `${label} must be ${required ? "1–" : "at most "}${max} characters.`);
  return clean;
}
export function event(project: Project, message: string) {
  const at = new Date().toISOString();
  project.events.unshift({ id: id(), text: message, at });
  project.updatedAt = at;
}
