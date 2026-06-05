import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reel Studio",
  description: "Add animated subtitles to your reels",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
