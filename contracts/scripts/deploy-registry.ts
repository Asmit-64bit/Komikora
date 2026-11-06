import { network } from "hardhat";
import { getAddress, isAddress, zeroAddress } from "viem";

function requiredAddress(name: string) {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`${name} must be a non-zero address`);
  return getAddress(value);
}

const admin = requiredAddress("REGISTRY_ADMIN_ADDRESS");
const relayer = requiredAddress("REGISTRY_RELAYER_ADDRESS");
const panel = Number(process.env.REGISTRY_MIN_PANEL_SIZE);
if (!Number.isInteger(panel) || panel < 1 || panel > 9) throw new Error("REGISTRY_MIN_PANEL_SIZE must be between 1 and 9");
const { viem } = await network.create();
const client = await viem.getPublicClient();
if (await client.getChainId() !== 16602) throw new Error("Registry deployment requires 0G Galileo (16602)");
const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction("ComicRatingRegistry", [admin, relayer, panel]);
const receipt = await client.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
if (receipt.status !== "success") throw new Error("Deployment failed");
console.log(`ComicRatingRegistry: ${contract.address} (transaction ${deploymentTransaction.hash})`);
