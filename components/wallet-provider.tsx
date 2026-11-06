"use client";

import { useState } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, rabbyWallet, rainbowWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { mainnet, sepolia, hardhat } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";
  const [config] = useState(() => createConfig({
    chains: [mainnet, sepolia, hardhat],
    connectors: connectorsForWallets([{ groupName: "Wallets", wallets: projectId
      ? [rainbowWallet, metaMaskWallet, rabbyWallet, walletConnectWallet, injectedWallet]
      : [injectedWallet, rabbyWallet],
    }], { appName: "ConsentCraft", projectId }),
    // EIP-6963 discovers installed wallets individually. The injected connector
    // also supports wallets that expose only window.ethereum.
    multiInjectedProviderDiscovery: true,
    ssr: true,
    transports: { [mainnet.id]: http(), [sepolia.id]: http(), [hardhat.id]: http("http://127.0.0.1:8545") },
  }));
  const [queryClient] = useState(() => new QueryClient());
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
