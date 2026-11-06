import type { Metadata } from "next";
import { Suspense } from "react";
import { StudioProvider } from "@/components/studio-provider";
import { WalletProvider } from "@/components/wallet-provider";
import { RainbowStudioProvider } from "@/components/rainbow-studio-provider";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConsentCraft — Good stories, made together",
  description: "A shared studio for comics. Create with your people, give everyone a voice, and make something together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        {/* Both wallet SDKs generate IDs during render; keep that work outside the static shell. */}
        <Suspense fallback={<div className="loading-state" role="status"><span className="loading-star" aria-hidden="true">✳</span><h2>Opening your studio…</h2></div>}>
          <WalletProvider><StudioProvider><RainbowStudioProvider>{children}</RainbowStudioProvider></StudioProvider></WalletProvider>
        </Suspense>
      </body>
    </html>
  );
}
