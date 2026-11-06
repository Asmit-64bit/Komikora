"use client";

import { useMemo } from "react";
import { createAuthenticationAdapter, lightTheme, RainbowKitAuthenticationProvider, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { useConfig } from "wagmi";
import { getAccount } from "wagmi/actions";
import { parseSiweMessage } from "viem/siwe";
import { studioRequest, useStudio } from "./studio-provider";

export function RainbowStudioProvider({ children }: { children: React.ReactNode }) {
  const config = useConfig();
  const { data, loading, execute, clearSession } = useStudio();
  const adapter = useMemo(() => createAuthenticationAdapter<string>({
    // RainbowKit requires this lifecycle hook. The real unpredictable nonce is
    // generated server-side in createMessage, never supplied by the client.
    getNonce: async () => "server-generated",
    createMessage: async ({ address, chainId }) => {
      await clearSession();
      const current = getAccount(config);
      if (current.address !== address || current.chainId !== chainId) throw new Error("Wallet changed. Try signing in again.");
      const { message } = await studioRequest<{ message: string }>({ action: "challenge", address, chainId });
      return message;
    },
    verify: async ({ message, signature }) => {
      const signed = parseSiweMessage(message);
      const current = getAccount(config);
      if (current.address !== signed.address || current.chainId !== signed.chainId) return false;
      await execute({ action: "siwe", message, signature });
      if (getAccount(config).address !== signed.address) { await clearSession(); return false; }
      return true;
    },
    // RainbowKit invokes this on account changes and disconnects. Local state
    // is cleared immediately; the provider surfaces any revocation failure.
    signOut: () => clearSession().catch(() => {}),
  }), [config, execute, clearSession]);
  return <RainbowKitAuthenticationProvider adapter={adapter} status={loading ? "loading" : data.user ? "authenticated" : "unauthenticated"}>
    <RainbowKitProvider modalSize="compact" appInfo={{ appName: "ConsentCraft" }} theme={lightTheme({ accentColor: "#c6b3ed", accentColorForeground: "#242424", borderRadius: "small", fontStack: "system", overlayBlur: "small" })}>
      {children}
    </RainbowKitProvider>
  </RainbowKitAuthenticationProvider>;
}
