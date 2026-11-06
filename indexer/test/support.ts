/** Test doubles built from events recorded on the real contract (test/fixtures/market-events.json). */
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";

import type { ManifestFetcher } from "../src/metadata.ts";
import { MemoryEntityStore } from "../src/memory-store.ts";
import type { BlockInfo, RawLog, SourceChain } from "../src/source.ts";
import { MemoryStateStore } from "../src/state.ts";
import type { IndexerContext } from "../src/sync.ts";
import type { IndexerConfig } from "../src/types.ts";

type FixtureLog = Omit<RawLog, "blockNumber"> & { blockNumber: string };
export const fixture = JSON.parse(readFileSync(new URL("./fixtures/market-events.json", import.meta.url), "utf8")) as {
  chainId: number;
  contract: Address;
  startBlock: string;
  endBlock: string;
  blocks: Record<string, { hash: Hex; parentHash: Hex; timestamp: string }>;
  logs: FixtureLog[];
  manifests: Record<string, string>;
  expected: { publications: { verifiedA: string; mismatchB: string; delistedC: string }; tradeCount: number };
};

export const PURCHASED_TOPIC = keccak256(toHex("Purchased(uint256,address,bytes32,uint256,uint256,uint256,uint256)"));

/** A source chain whose head and history the test controls, including reorganizations. */
export class FakeSource implements SourceChain {
  blocks = new Map<bigint, BlockInfo>();
  logs: RawLog[];
  head: bigint;
  duplicateLogs = false;
  getLogsCalls = 0;

  constructor() {
    for (const [n, b] of Object.entries(fixture.blocks)) {
      this.blocks.set(BigInt(n), { number: BigInt(n), hash: b.hash, parentHash: b.parentHash, timestamp: BigInt(b.timestamp) });
    }
    this.logs = fixture.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
    this.head = BigInt(fixture.endBlock);
  }
  async chainId() {
    return fixture.chainId;
  }
  async headBlockNumber() {
    return this.head;
  }
  async getBlock(n: bigint) {
    const b = this.blocks.get(n);
    if (!b) throw new Error(`no block ${n}`);
    return b;
  }
  async getLogs(_address: Address, from: bigint, to: bigint) {
    this.getLogsCalls++;
    const out = this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    return this.duplicateLogs ? [...out, ...out] : out;
  }

  /** Mines empty blocks on top of the head. */
  mine(n: number) {
    for (let i = 0; i < n; i++) {
      const parent = this.blocks.get(this.head)!;
      this.head++;
      this.blocks.set(this.head, { number: this.head, hash: keccak256(toHex(`mined ${this.head} ${parent.hash}`)), parentHash: parent.hash, timestamp: parent.timestamp + 12n });
    }
  }

  /**
   * Replaces every block from `fromBlock` with a new branch (new hashes). `keep` decides which old
   * logs survive into the new branch; survivors get the new block hashes.
   */
  reorg(fromBlock: bigint, keep: (l: RawLog) => boolean) {
    for (let n = fromBlock; n <= this.head; n++) {
      const b = this.blocks.get(n)!;
      this.blocks.set(n, { ...b, hash: keccak256(toHex(`reorg ${n} ${b.hash}`)) });
    }
    this.logs = this.logs
      .filter((l) => l.blockNumber < fromBlock || keep(l))
      .map((l) => (l.blockNumber >= fromBlock ? { ...l, blockHash: this.blocks.get(l.blockNumber)!.hash } : l));
  }
}

/** Serves the recorded manifests; can fail or serve other bytes. */
export class FakeFetcher implements ManifestFetcher {
  calls: string[] = [];
  failing = new Set<string>();
  overrides = new Map<string, Uint8Array>();
  async fetch(txId: string) {
    this.calls.push(txId);
    if (this.failing.has(txId)) throw new Error("gateway timeout (injected)");
    const override = this.overrides.get(txId);
    if (override) return override;
    const b64 = fixture.manifests[txId];
    if (!b64) throw new Error(`HTTP 404 for ${txId}`);
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
}

export function testConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    chainId: fixture.chainId,
    contract: fixture.contract,
    startBlock: BigInt(fixture.startBlock),
    confirmations: 0,
    batchBlocks: 5,
    ttlDays: 180,
    renewBeforeDays: 30,
    retry: { attempts: 3, baseDelayMs: 0 },
    metadataRetryMs: 60_000,
    metadataMaxAttempts: 5,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<IndexerConfig> = {}) {
  const source = new FakeSource();
  const store = new MemoryEntityStore();
  const fetcher = new FakeFetcher();
  const stateStore = new MemoryStateStore();
  const logs: string[] = [];
  let clock = new Date("2026-11-06T00:00:00Z");
  const ctx: IndexerContext = {
    source,
    store,
    fetcher,
    stateStore,
    config: testConfig(overrides),
    log: (m) => logs.push(m),
    now: () => clock,
  };
  return { ctx, source, store, fetcher, stateStore, logs, advanceClock: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}
