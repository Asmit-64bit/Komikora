import type { Metadata } from "next";
import { PreviewProvider } from "@/components/preview-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConsentCraft — Good stories, made together",
  description: "A shared studio for comics. Create with your people, give everyone a voice, and make something together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body><PreviewProvider>{children}</PreviewProvider></body>
    </html>
  );
}
