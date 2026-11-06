import { createPublicClient, http, type Address, type Hex } from "viem";

/** A log exactly as the source chain returns it. */
export type RawLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
};

export type BlockInfo = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };

/** The chain the market contract lives on (Sepolia). Read-only. */
export interface SourceChain {
  chainId(): Promise<number>;
  headBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<BlockInfo>;
  /** Logs emitted by `address` in [fromBlock, toBlock], in chain order. */
  getLogs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
}

export function viemSource(rpcUrl: string): SourceChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 3 }) });
  return {
    chainId: () => client.getChainId(),
    headBlockNumber: () => client.getBlockNumber(),
    async getBlock(blockNumber) {
      const b = await client.getBlock({ blockNumber });
      if (!b.hash) throw new Error(`Block ${blockNumber} has no hash (pending)`);
      return { number: blockNumber, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
    },
    async getLogs(address, fromBlock, toBlock) {
      const logs = await client.getLogs({ address, fromBlock, toBlock });
      return logs.map((l) => {
        if (l.blockHash === null || l.transactionHash === null || l.logIndex === null || l.blockNumber === null) {
          throw new Error("Received a pending log; only mined logs can be indexed");
        }
        return {
          address: l.address,
          topics: l.topics as Hex[],
          data: l.data,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          transactionIndex: l.transactionIndex ?? 0,
          logIndex: l.logIndex,
        };
      });
    },
  };
}
