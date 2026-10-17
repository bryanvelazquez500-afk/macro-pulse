import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MacroPulse",
  description: "MacroPulse — standardized corporate financials, intrinsic valuation and global equity discovery",
  applicationName: "MacroPulse",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d", // macropulse-obsidian
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // MacroPulse is dark-only: the `dark` class turns on every `dark:` variant (see globals.css).
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-macropulse-obsidian">{children}</body>
    </html>
  );
}
