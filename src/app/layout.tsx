import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Data Studio",
  description: "Rust + WASM powered BI platform",
};

// Supabase-style typography: clean sans for UI, monospace for code/data.
const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * Run before first paint to apply the saved/system theme, avoiding a
 * light→dark flash (FOUC). `suppressHydrationWarning` on <html> is required
 * because this script mutates the class list before React hydrates.
 *
 * theme is one of "light" | "dark" | "system" (default: system → follows OS).
 */
const themeScript = `
(function () {
  try {
    var t = localStorage.getItem("theme");
    var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = t === "dark" || ((t === "system" || !t) && systemDark);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
