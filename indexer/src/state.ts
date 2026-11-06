import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { IndexerState } from "./types.ts";

export interface StateStore {
  load(): Promise<IndexerState | null>;
  save(state: IndexerState): Promise<void>;
}

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v !== null && typeof v === "object" && "$bigint" in v && Object.keys(v).length === 1 ? BigInt((v as { $bigint: string }).$bigint) : v;

export function serializeState(state: IndexerState): string {
  return `${JSON.stringify(state, replacer, 2)}\n`;
}
export function parseState(text: string): IndexerState {
  return JSON.parse(text, reviver) as IndexerState;
}

/** JSON file, written atomically (temp file + rename) so a crash never leaves half a state. */
export class FileStateStore implements StateStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load() {
    return existsSync(this.path) ? parseState(readFileSync(this.path, "utf8")) : null;
  }
  async save(state: IndexerState) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, serializeState(state));
    renameSync(tmp, this.path);
  }
}

export class MemoryStateStore implements StateStore {
  text: string | null = null;
  async load() {
    return this.text ? parseState(this.text) : null;
  }
  async save(state: IndexerState) {
    this.text = serializeState(state);
  }
}
