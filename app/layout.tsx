import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Newsreader } from "next/font/google";
import { StudioProvider } from "@/components/studio-provider";
import { WalletProvider } from "@/components/wallet-provider";
import { RainbowStudioProvider } from "@/components/rainbow-studio-provider";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-inter", display: "swap" });
// Lead/subtitle face: a light editorial serif, a touch more expressive than Inter.
const newsreader = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--font-newsreader", display: "swap" });

export const metadata: Metadata = {
  title: "ConsentCraft — Good stories, made together",
  description: "A shared studio for comics. Create with your people, give everyone a voice, and make something together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`}>
      <body>
        {/* Both wallet SDKs generate IDs during render; keep that work outside the static shell. */}
        <Suspense fallback={<div className="loading-state" role="status"><span className="loading-star" aria-hidden="true">✳</span><h2>Opening your studio…</h2></div>}>
          <WalletProvider><StudioProvider><RainbowStudioProvider>{children}</RainbowStudioProvider></StudioProvider></WalletProvider>
        </Suspense>
      </body>
    </html>
  );
}
