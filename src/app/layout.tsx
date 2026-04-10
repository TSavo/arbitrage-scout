import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "Arbitrage Scout",
  description: "Collectibles arbitrage opportunity tracker",
};

const navLinks = [
  { href: "/", label: "Dashboard", icon: "⬡" },
  { href: "/opportunities", label: "Opportunities", icon: "◆" },
  { href: "/products", label: "Products", icon: "◈" },
  { href: "/scans", label: "Scans", icon: "◎" },
  { href: "/platforms", label: "Platforms", icon: "◇" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex bg-background text-foreground">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 flex flex-col border-r border-border bg-card">
          <div className="px-5 py-5 border-b border-border">
            <span className="text-xs font-mono font-semibold tracking-widest text-muted-foreground uppercase">
              Arbitrage
            </span>
            <h1 className="text-lg font-bold leading-tight text-foreground">
              Scout
            </h1>
          </div>
          <nav className="flex-1 py-4 px-2 space-y-0.5">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <span className="text-xs opacity-60">{link.icon}</span>
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="px-4 py-3 border-t border-border">
            <p className="text-[10px] text-muted-foreground/50 font-mono">
              arbitrage-scout-ts
            </p>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
