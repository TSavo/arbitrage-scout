export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import {
  opportunities,
  products,
  scanLogs,
  listings,
  marketplaces,
} from "@/db/schema";
import { desc, eq, count, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function timeAgo(ts: string | null | undefined) {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function DashboardPage() {
  const [statusCounts, productCount, lastScan, recentOpps] = await Promise.all([
    db
      .select({ status: opportunities.status, count: count() })
      .from(opportunities)
      .groupBy(opportunities.status),
    db.select({ count: count() }).from(products),
    db
      .select({
        startedAt: scanLogs.startedAt,
        marketplaceId: scanLogs.marketplaceId,
        opportunitiesFound: scanLogs.opportunitiesFound,
        listingsFound: scanLogs.listingsFound,
      })
      .from(scanLogs)
      .orderBy(desc(scanLogs.startedAt))
      .limit(1),
    db
      .select({
        id: opportunities.id,
        listingPriceUsd: opportunities.listingPriceUsd,
        marketPriceUsd: opportunities.marketPriceUsd,
        profitUsd: opportunities.profitUsd,
        marginPct: opportunities.marginPct,
        status: opportunities.status,
        foundAt: opportunities.foundAt,
        flags: opportunities.flags,
        listingTitle: listings.title,
        marketplaceId: listings.marketplaceId,
        marketplaceName: marketplaces.name,
      })
      .from(opportunities)
      .innerJoin(listings, eq(opportunities.listingId, listings.id))
      .innerJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
      .orderBy(desc(opportunities.foundAt))
      .limit(8),
  ]);

  const byStatus = Object.fromEntries(
    statusCounts.map((r) => [r.status, r.count]),
  );
  const totalOpps = statusCounts.reduce((s, r) => s + r.count, 0);
  const scan = lastScan[0];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm mt-0.5" style={{ color: "#9295a0" }}>
          Collectibles arbitrage overview
        </p>
      </div>

      {/* Stat cards — each with its own color identity */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Opportunities — emerald */}
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "linear-gradient(135deg, #0a1f15, #0f2b1c)",
            borderColor: "#1a3d2a",
          }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "#4ade80" }}>
            Opportunities
          </p>
          <p className="text-3xl font-bold mt-1" style={{ color: "#34d399" }}>
            {totalOpps}
          </p>
          <div className="flex gap-2 mt-3 flex-wrap">
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "#34d39920", color: "#34d399" }}>
              {byStatus["new"] ?? 0} new
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "#38bdf820", color: "#38bdf8" }}>
              {byStatus["reviewed"] ?? 0} reviewed
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "#fbbf2420", color: "#fbbf24" }}>
              {byStatus["purchased"] ?? 0} bought
            </span>
          </div>
        </div>

        {/* Products — blue */}
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "linear-gradient(135deg, #0a1525, #0f1c30)",
            borderColor: "#1a2d4a",
          }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "#60a5fa" }}>
            Products in Catalog
          </p>
          <p className="text-3xl font-bold mt-1" style={{ color: "#38bdf8" }}>
            {(productCount[0]?.count ?? 0).toLocaleString()}
          </p>
          <p className="text-[11px] mt-3" style={{ color: "#5b7a9a" }}>
            Tracked across all categories
          </p>
        </div>

        {/* Last Scan — same navy family */}
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "linear-gradient(135deg, #101828, #152035)",
            borderColor: "#1e2d4a",
          }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "#6880a8" }}>
            Last Scan
          </p>
          <p className="text-3xl font-bold mt-1" style={{ color: "#e8ecf4" }} suppressHydrationWarning>
            {scan ? timeAgo(scan.startedAt) : "—"}
          </p>
          <p className="text-[11px] mt-3" style={{ color: "#4a6080" }}>
            {scan?.marketplaceId ?? "No scans yet"}
          </p>
        </div>

        {/* Last Results */}
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "linear-gradient(135deg, #101828, #152035)",
            borderColor: "#1e2d4a",
          }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "#6880a8" }}>
            Last Scan Results
          </p>
          <p className="text-3xl font-bold mt-1" style={{ color: "#e8ecf4" }}>
            {scan?.opportunitiesFound ?? "—"}
          </p>
          <p className="text-[11px] mt-3" style={{ color: "#4a6080" }}>
            {scan ? `${scan.listingsFound} listings scanned` : "No data"}
          </p>
        </div>
      </div>

      {/* Recent opportunities */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Recent Opportunities</h3>
          <Link
            href="/opportunities"
            className="text-xs hover:text-foreground transition-colors"
            style={{ color: "#34d399" }}
          >
            View all →
          </Link>
        </div>

        {recentOpps.length === 0 ? (
          <div
            className="rounded-lg border p-10 text-center text-sm"
            style={{ background: "#131c2e", borderColor: "#1e2d4a", color: "#8892aa" }}
          >
            No opportunities found yet. Run a scan to get started.
          </div>
        ) : (
          <div className="space-y-1.5">
            {recentOpps.map((opp) => {
              const margin = opp.marginPct * 100;
              // Color the left border by profit margin
              const borderColor =
                margin > 500 ? "#c084fc" : // purple = insane deal
                margin > 100 ? "#34d399" : // green = great
                margin > 50 ? "#38bdf8" :  // blue = good
                "#fbbf24";                  // amber = okay

              return (
                <Link
                  key={opp.id}
                  href="/opportunities"
                  className="rounded-lg border py-3 px-4 flex items-start justify-between gap-4 transition-colors hover:border-opacity-60 block"
                  style={{
                    background: "#131c2e",
                    borderColor: "#1e2d4a",
                    borderLeftWidth: 3,
                    borderLeftColor: borderColor,
                    textDecoration: "none",
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate" style={{ color: "#e8e8ed" }}>
                      {opp.listingTitle}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: "#38bdf815", color: "#38bdf8" }}
                      >
                        {opp.marketplaceName}
                      </span>
                      <Badge variant="default" className="text-[10px]">
                        {opp.status}
                      </Badge>
                      {(opp.flags as string[]).map((flag) => (
                        <span
                          key={flag}
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: "#fbbf2415", color: "#fbbf24" }}
                        >
                          {flag}
                        </span>
                      ))}
                      <span className="text-[10px]" style={{ color: "#6b6b76" }} suppressHydrationWarning>
                        {timeAgo(opp.foundAt)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className="text-sm font-semibold"
                      style={{
                        color: "#34d399",
                        fontFamily: "var(--font-mono)",
                        textShadow: "0 0 12px #34d39930",
                      }}
                    >
                      {fmt(opp.profitUsd)}
                    </p>
                    <p className="text-[11px]" style={{ color: "#34d39980", fontFamily: "var(--font-mono)" }}>
                      {fmtPct(opp.marginPct)} margin
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: "#6b6b76", fontFamily: "var(--font-mono)" }}>
                      {fmt(opp.listingPriceUsd)} → {fmt(opp.marketPriceUsd)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
