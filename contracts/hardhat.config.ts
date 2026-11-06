import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Configuration variables are resolved lazily, only when a task uses them: first from
// the Hardhat keystore (`npx hardhat keystore set NAME`), then from the environment
// (contracts/.env, loaded by the npm scripts). Compiling and testing need none of them.
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    // The optimizer keeps ConsentCraftMarket under the 24,576-byte EIP-170 deploy limit.
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    ogGalileo: {
      type: "http",
      chainType: "l1",
      chainId: 16602,
      url: configVariable("OG_RPC_URL"),
      accounts: [configVariable("OG_DEPLOYER_PRIVATE_KEY")],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_DEPLOYER_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
