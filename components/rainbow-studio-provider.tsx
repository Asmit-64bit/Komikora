"use client";

import { useMemo, useState } from "react";
import { createAuthenticationAdapter, darkTheme, type Theme, RainbowKitAuthenticationProvider, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { useConfig } from "wagmi";
import { getAccount } from "wagmi/actions";
import { parseSiweMessage } from "viem/siwe";
import { studioRequest, useStudio } from "./studio-provider";

// Dark editorial theme: graphite surfaces, light pill actions, sharp modal, no shadows.
const baseTheme = darkTheme({ accentColor: "#f4f3f1", accentColorForeground: "#0a0a0b", borderRadius: "none", fontStack: "system", overlayBlur: "small" });
const walletTheme: Theme = {
  ...baseTheme,
  fonts: { body: "var(--font-inter), ui-sans-serif, system-ui, sans-serif" },
  radii: { ...baseTheme.radii, actionButton: "75px", connectButton: "75px", menuButton: "75px", modal: "0px", modalMobile: "0px" },
  shadows: { connectButton: "none", dialog: "none", profileDetailsAction: "none", selectedOption: "none", selectedWallet: "none", walletLogo: "none" },
  colors: { ...baseTheme.colors, modalBackground: "#111113", modalBorder: "rgba(255, 255, 255, 0.16)", modalBackdrop: "rgba(0, 0, 0, 0.7)", generalBorder: "rgba(255, 255, 255, 0.08)", menuItemBackground: "rgba(255, 255, 255, 0.06)", connectButtonBackground: "#0a0a0b", connectButtonInnerBackground: "#1a1a1e" },
};

export function RainbowStudioProvider({ children }: { children: React.ReactNode }) {
  const config = useConfig();
  const { data, loading, execute, clearSession } = useStudio();
  const [authError, setAuthError] = useState("");
  const adapter = useMemo(() => createAuthenticationAdapter<string>({
    // RainbowKit requires this lifecycle hook. The real unpredictable nonce is
    // generated server-side in createMessage, never supplied by the client.
    getNonce: async () => "server-generated",
    createMessage: async ({ address, chainId }) => {
      setAuthError("");
      try {
      await clearSession();
      const current = getAccount(config);
      if (current.address !== address || current.chainId !== chainId) throw new Error("Wallet changed. Try signing in again.");
      const { message } = await studioRequest<{ message: string }>({ action: "challenge", address, chainId });
      return message;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Sign-in could not be prepared. Please retry.");
        throw error;
      }
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
    <RainbowKitProvider modalSize="compact" appInfo={{ appName: "ConsentCraft" }} theme={walletTheme}>
      {children}
      {authError && <div className="toast" role="alert" style={{ zIndex: 2147483647 }}><span>{authError}</span><button className="icon-button" aria-label="Dismiss sign-in error" onClick={() => setAuthError("")}>×</button></div>}
    </RainbowKitProvider>
  </RainbowKitAuthenticationProvider>;
}
