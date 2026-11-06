/**
 * In-memory EntityStore with Arkiv's semantics that matter to the indexer: keys assigned by the
 * store, owner-scoped reads, block-based expiry, and injectable write failures. Used by the tests
 * and by `backfill --dry-run`.
 */
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";

import type { ListingValues, TradeValues } from "./entities.ts";
import { EntityGoneError, type EntityKind, type EntityStore, type StoredEntity } from "./store.ts";

type Row = { kind: EntityKind; owner: Address; values: ListingValues | TradeValues; expiresAt: bigint };
type Op = "create" | "patch" | "extend" | "remove";

export class MemoryEntityStore implements EntityStore {
  readonly owner: Address;
  readonly rows = new Map<Hex, Row>();
  block = 1_000n;
  readonly writes: { op: Op; kind?: EntityKind; entityKey: Hex }[] = [];
  private nonce = 0;
  private failures: { op: Op | "any"; remaining: number; skip: number }[] = [];

  constructor(owner: Address = "0x00000000000000000000000000000000000000aa") {
    this.owner = getAddress(owner);
  }

  /** After `skip` successful writes of `op`, the next `count` throw, as a flaky RPC or out-of-gas would. */
  failNext(op: Op | "any", count: number, skip = 0) {
    this.failures.push({ op, remaining: count, skip });
  }

  clearFailures() {
    this.failures = [];
  }

  /** Advances Arkiv time; entities whose expiry passes disappear. */
  advanceBlocks(n: bigint) {
    this.block += n;
    for (const [k, r] of this.rows) if (r.expiresAt <= this.block) this.rows.delete(k);
  }

  /** Writes an entity as a different owner (a spoofer using our schema). */
  injectForeign(kind: EntityKind, values: ListingValues | TradeValues, owner: Address) {
    const k = this.mintKey();
    this.rows.set(k, { kind, owner: getAddress(owner), values, expiresAt: this.block + 1_000_000n });
    return k;
  }

  live(kind: EntityKind): Row[] {
    return [...this.rows.values()].filter((r) => r.kind === kind && r.owner === this.owner);
  }

  private maybeFail(op: Op) {
    const f = this.failures.find((x) => (x.op === op || x.op === "any") && x.remaining > 0);
    if (!f) return;
    if (f.skip > 0) {
      f.skip--;
      return;
    }
    f.remaining--;
    throw new Error(`Injected ${op} failure`);
  }

  private mintKey(): Hex {
    return keccak256(toHex(`memory-entity-${this.nonce++}`));
  }

  private idOf(kind: EntityKind, v: ListingValues | TradeValues): Hex {
    return kind === "listing" ? (v as ListingValues).listingId : (v as TradeValues).tradeId;
  }

  async blockNumber() {
    return this.block;
  }
  blocksPerDay() {
    return 43_200;
  }

  async findById(kind: EntityKind, id: Hex): Promise<StoredEntity | null> {
    for (const [entityKey, r] of this.rows) {
      if (r.kind === kind && r.owner === this.owner && this.idOf(kind, r.values) === id) {
        return { entityKey, id, expiresAt: r.expiresAt, contentHash: r.values.contentHash };
      }
    }
    return null;
  }

  async listOwned(kind: EntityKind, chainId: number, contract: Address): Promise<StoredEntity[]> {
    return [...this.rows.entries()]
      .filter(([, r]) => r.kind === kind && r.owner === this.owner && r.values.chainId === BigInt(chainId) && getAddress(r.values.contract) === getAddress(contract))
      .map(([entityKey, r]) => ({ entityKey, id: this.idOf(kind, r.values), expiresAt: r.expiresAt, contentHash: r.values.contentHash }));
  }

  private create(kind: EntityKind, values: ListingValues | TradeValues, ttlDays: number) {
    this.maybeFail("create");
    const entityKey = this.mintKey();
    const expiresAt = this.block + BigInt(ttlDays * this.blocksPerDay());
    this.rows.set(entityKey, { kind, owner: this.owner, values: { ...values }, expiresAt });
    this.writes.push({ op: "create", kind, entityKey });
    return { entityKey, expiresAt };
  }
  async createListing(values: ListingValues, ttlDays: number) {
    return this.create("listing", values, ttlDays);
  }
  async createTrade(values: TradeValues, ttlDays: number) {
    return this.create("trade", values, ttlDays);
  }

  private patch(entityKey: Hex, values: ListingValues | TradeValues) {
    this.maybeFail("patch");
    const row = this.rows.get(entityKey);
    if (!row) throw new EntityGoneError(`Entity ${entityKey} is gone`);
    row.values = { ...values };
    this.writes.push({ op: "patch", kind: row.kind, entityKey });
  }
  async patchListing(entityKey: Hex, values: ListingValues) {
    this.patch(entityKey, values);
  }
  async patchTrade(entityKey: Hex, values: TradeValues) {
    this.patch(entityKey, values);
  }

  async extend(entityKey: Hex, ttlDays: number) {
    this.maybeFail("extend");
    const row = this.rows.get(entityKey);
    if (!row) throw new EntityGoneError(`Entity ${entityKey} is gone`);
    row.expiresAt = this.block + BigInt(ttlDays * this.blocksPerDay());
    this.writes.push({ op: "extend", kind: row.kind, entityKey });
    return row.expiresAt;
  }

  async remove(entityKey: Hex) {
    this.maybeFail("remove");
    const row = this.rows.get(entityKey);
    this.rows.delete(entityKey);
    this.writes.push({ op: "remove", kind: row?.kind, entityKey });
  }
}
