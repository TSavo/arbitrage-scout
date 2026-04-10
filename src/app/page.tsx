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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "new") return "default";
  if (status === "reviewed") return "secondary";
  if (status === "purchased") return "outline";
  return "secondary";
}

export default async function DashboardPage() {
  const [
    statusCounts,
    productCount,
    lastScan,
    recentOpps,
  ] = await Promise.all([
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
      .limit(5),
  ]);

  const byStatus = Object.fromEntries(
    statusCounts.map((r) => [r.status, r.count])
  );
  const totalOpps = statusCounts.reduce((s, r) => s + r.count, 0);
  const scan = lastScan[0];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Collectibles arbitrage overview
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Total Opportunities
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalOpps}</div>
            <div className="flex gap-2 mt-2 flex-wrap">
              <Badge variant="default" className="text-xs">
                {byStatus["new"] ?? 0} new
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {byStatus["reviewed"] ?? 0} reviewed
              </Badge>
              <Badge variant="outline" className="text-xs">
                {byStatus["purchased"] ?? 0} purchased
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Products in Catalog
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{productCount[0]?.count ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-2">Tracked items</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Last Scan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {scan ? timeAgo(scan.startedAt) : "—"}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {scan?.marketplaceId ?? "No scans yet"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Last Scan Results
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {scan?.opportunitiesFound ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {scan ? `${scan.listingsFound} listings scanned` : "No data"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent opportunities */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Recent Opportunities</h3>
          <Link
            href="/opportunities"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all →
          </Link>
        </div>

        {recentOpps.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No opportunities found yet. Run a scan to get started.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentOpps.map((opp) => (
              <Card key={opp.id} className="hover:bg-accent/30 transition-colors">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {opp.listingTitle}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant="outline" className="text-xs">
                          {opp.marketplaceName}
                        </Badge>
                        <Badge variant={statusVariant(opp.status)} className="text-xs">
                          {opp.status}
                        </Badge>
                        {(opp.flags as string[]).map((flag) => (
                          <Badge key={flag} variant="secondary" className="text-xs">
                            {flag}
                          </Badge>
                        ))}
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(opp.foundAt)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-mono text-green-400 font-semibold">
                        {fmt(opp.profitUsd)}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {fmtPct(opp.marginPct)} margin
                      </p>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {fmt(opp.listingPriceUsd)} → {fmt(opp.marketPriceUsd)}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
