import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { API_URL } from "@/lib/api";
import { THEME_SCRIPT, earlyFetchScript } from "@/lib/themeScript";

const sans = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

// Mono is reserved for tickers, CIKs, fiscal dates, form types and XBRL tags.
const mono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["500", "600"],
});

export const metadata: Metadata = {
  title: "MacroPulse",
  description: "MacroPulse — standardized corporate financials, intrinsic valuation and global equity discovery",
  applicationName: "MacroPulse",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f6f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1412" },
  ], // --canvas in each theme
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // data-theme is set by THEME_SCRIPT before hydration, so React must not warn about it.
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <head>
        {/* Sets data-theme before first paint (saved choice, else the system setting): no theme flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Open the API connection and start the first company's requests before the app loads. */}
        <link rel="preconnect" href={API_URL} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={API_URL} />
        <script dangerouslySetInnerHTML={{ __html: earlyFetchScript(API_URL) }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas">{children}</body>
    </html>
  );
}
