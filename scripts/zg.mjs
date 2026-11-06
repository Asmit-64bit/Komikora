// 0G Compute operator tool for the AI review wallet (Direct mode).
//
//   npm run zg -- providers                  list inference providers (read-only, no key)
//   npm run zg -- account                    ledger and provider sub-account balances
//   npm run zg -- setup <ledger0G> <provider0G>
//                                            deposit to the ledger (min 3 0G on first use),
//                                            then fund and acknowledge ZG_PROVIDER_ADDRESS (min 1 0G)
//
// Reads ZG_PRIVATE_KEY, ZG_RPC_URL and ZG_PROVIDER_ADDRESS from .env.local. Prints no secrets.
import { createZGComputeNetworkBroker, createZGComputeNetworkReadOnlyBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";

const [command = "providers", ...args] = process.argv.slice(2);
const rpcUrl = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
const provider = process.env.ZG_PROVIDER_ADDRESS;
const fmt = neuron => `${formatEther(neuron)} 0G`;

async function signer() {
  const key = process.env.ZG_PRIVATE_KEY;
  if (!key) throw new Error("Set ZG_PRIVATE_KEY in .env.local first.");
  const wallet = new Wallet(key, new JsonRpcProvider(rpcUrl));
  console.log(`0G wallet ${wallet.address}, native balance ${fmt(await wallet.provider.getBalance(wallet.address))}`);
  return createZGComputeNetworkBroker(wallet);
}

if (command === "providers") {
  const broker = await createZGComputeNetworkReadOnlyBroker(rpcUrl);
  for (const s of await broker.inference.listService()) {
    console.log(`${s.provider}  ${s.serviceType.padEnd(8)} ${s.verifiability.padEnd(7)} ${s.model}`);
    console.log(`    input ${fmt(s.inputPrice)} / token, output ${fmt(s.outputPrice)} / token`);
  }
} else if (command === "account") {
  const broker = await signer();
  const ledger = await broker.ledger.getLedger().catch(() => null);
  console.log(ledger ? `ledger: total ${fmt(ledger.totalBalance)}, available ${fmt(ledger.availableBalance)}` : "no ledger yet (run setup)");
  if (provider) {
    const account = await broker.inference.getAccount(provider).catch(() => null);
    console.log(account ? `provider ${provider}: balance ${fmt(account.balance)}` : `no sub-account with ${provider} yet`);
  }
} else if (command === "setup") {
  const [ledgerAmount, providerAmount] = args;
  if (!provider || !ledgerAmount || !providerAmount) throw new Error("Usage: npm run zg -- setup <ledger0G> <provider0G> (with ZG_PROVIDER_ADDRESS set)");
  const broker = await signer();
  const existing = await broker.ledger.getLedger().catch(() => null);
  if (existing) await broker.ledger.depositFund(Number(ledgerAmount));
  else await broker.ledger.addLedger(Number(ledgerAmount));
  console.log(`deposited ${ledgerAmount} 0G to the ledger`);
  await broker.ledger.transferFund(provider, "inference", parseEther(providerAmount));
  console.log(`transferred ${providerAmount} 0G to ${provider} (this also acknowledges its TEE signer)`);
} else {
  throw new Error(`Unknown command ${command}`);
}
process.exit(0);
