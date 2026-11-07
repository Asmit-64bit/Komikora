import "server-only";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, zeroAddress, type Address } from "viem";
import { heirloomAbi } from "@/lib/heirloom-abi";
import { confirmedReading } from "./reading-chain";

export async function heirloomSnapshot(owner: Address, viewer?: Address) {
  const cfg = await confirmedReading();
  const base = { address: cfg.address, abi: heirloomAbi, blockNumber: cfg.blockNumber } as const;
  try {
    const version = await cfg.client.readContract({ ...base, functionName: "heirloomVersion" });
    if (version !== BigInt(1)) return { supported: false as const, contract: cfg.address, chainId: cfg.chainId };
  } catch (error) {
    // An older deployed marketplace has no inheritance methods. Network failures
    // must remain errors rather than falsely identifying a deployment as old.
    if (error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return { supported: false as const, contract: cfg.address, chainId: cfg.chainId };
    throw error;
  }
  const [p, heirs, credit, claimable, block] = await Promise.all([
    cfg.client.readContract({ ...base, functionName: "inheritancePlans", args: [owner] }),
    cfg.client.readContract({ ...base, functionName: "getHeirs", args: [owner] }),
    cfg.client.readContract({ ...base, functionName: "credits", args: [owner] }),
    viewer ? cfg.client.readContract({ ...base, functionName: "claimableInheritedProceeds", args: [owner, viewer] }) : BigInt(0),
    cfg.client.getBlock({ blockNumber: cfg.blockNumber }),
  ]);
  return { supported: true as const, contract: cfg.address, chainId: cfg.chainId, owner: getAddress(owner), viewer: viewer || zeroAddress, block: cfg.blockNumber.toString(), timestamp: block.timestamp.toString(), credit: credit.toString(), claimable: claimable.toString(), plan: { lastActivity: p[0].toString(), inactivityPeriod: p[1].toString(), challengePeriod: p[2].toString(), claimStartedAt: p[3].toString(), guardian: p[4], vetoesUsed: p[5], configured: p[6], finalized: p[7], heirs: heirs[0].map((address, i) => ({ address, bps: heirs[1][i] })) } };
}
