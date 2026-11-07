import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Playfair_Display } from "next/font/google";
import { StudioProvider } from "@/components/studio-provider";
import { WalletProvider } from "@/components/wallet-provider";
import { RainbowStudioProvider } from "@/components/rainbow-studio-provider";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
import "./text-stroke.css"; // subtle font stroke — remove this line to revert

const inter = Inter({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-playfair", display: "swap" });

export const metadata: Metadata = {
  title: "Komikora — Good stories, made together",
  description: "A shared studio for comics. Create with your people, give everyone a voice, and make something together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body>
        {/* Both wallet SDKs generate IDs during render; keep that work outside the static shell. */}
        <Suspense fallback={<div className="loading-state" role="status"><span className="loading-star" aria-hidden="true">✳</span><h2>Opening your studio…</h2></div>}>
          <WalletProvider><StudioProvider><RainbowStudioProvider>{children}</RainbowStudioProvider></StudioProvider></WalletProvider>
        </Suspense>
      </body>
    </html>
  );
}
