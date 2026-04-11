import type { Metadata } from "next";
import { Sora, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { SidebarNav } from "@/components/SidebarNav";
import "./globals.css";

const sora = Sora({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Arbitrage Scout",
  description: "Collectibles arbitrage opportunity tracker",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} dark h-full antialiased`}
    >
      <body
        className="min-h-full flex bg-background text-foreground"
        style={{ fontFamily: "var(--font-body), system-ui, sans-serif" }}
      >
        {/* Sidebar */}
        <aside
          className="w-48 shrink-0 flex flex-col border-r"
          style={{ background: "#091020", borderColor: "#1e2d4a" }}
        >
          {/* Brand */}
          <div className="px-4 py-4 border-b" style={{ borderColor: "#262a36" }}>
            <div className="flex items-center gap-2.5">
              <div
                className="w-7 h-7 rounded-md flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #34d399, #059669)" }}
              >
                <span className="text-[11px] font-bold" style={{ color: "#052e16" }}>
                  AS
                </span>
              </div>
              <div>
                <h1
                  className="text-[13px] font-semibold leading-none tracking-tight"
                  style={{ fontFamily: "var(--font-heading)", color: "#e4e4e7" }}
                >
                  Scout
                </h1>
                <span
                  className="text-[9px] tracking-[0.08em] uppercase"
                  style={{ color: "#34d399" }}
                >
                  arbitrage
                </span>
              </div>
            </div>
          </div>

          {/* Nav (client component for active state) */}
          <SidebarNav />

          {/* Status */}
          <div className="px-4 py-3 border-t" style={{ borderColor: "#262a36" }}>
            <div className="flex items-center gap-2">
              <div className="relative">
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: "#34d399" }}
                />
                <div
                  className="absolute inset-0 w-1.5 h-1.5 rounded-full animate-ping"
                  style={{ background: "#34d399", opacity: 0.4 }}
                />
              </div>
              <span
                className="text-[10px]"
                style={{ color: "#52525e", fontFamily: "var(--font-mono)" }}
              >
                live
              </span>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col min-w-0 overflow-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
