"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Sparkline } from "@/components/Sparkline";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

type Mover = {
  product_id: string;
  first_price: number;
  last_price: number;
  change_pct: number;
  change_usd: number;
  title: string;
  platform: string | null;
};

type Deal = {
  product_id: string;
  title: string;
  platform: string | null;
  marketplace_name: string;
  listing_price_usd: number;
  market_price_usd: number;
  profit_usd: number;
  margin_pct: number;
  url: string | null;
};

type BucketRow = {
  bucket: string;
  count: number;
};

type PlatformRow = {
  platform: string;
  product_count: number;
  avg_price: number;
  avg_volume: number;
};

type Stats = {
  product_count: number;
  avg_loose: number | null;
  avg_volume: number;
  total_opportunities: number;
  avg_margin: number | null;
};

type ProductType = {
  id: string;
  name: string;
  conditionSchema: string[];
  metadataSchema: string[];
};

type Props = {
  productType: ProductType;
  stats: Stats;
  movers: Mover[];
  sparklineMap: Record<string, { value: number }[]>;
  deals: Deal[];
  distribution: BucketRow[];
  platforms: PlatformRow[];
};

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export default function CategoryClient({
  productType,
  stats,
  movers,
  sparklineMap,
  deals,
  distribution,
  platforms,
}: Props) {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/categories"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Categories
        </Link>
        <h2 className="text-2xl font-semibold tracking-tight mt-2">
          {productType.name}
        </h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Deep dive into {productType.name.toLowerCase()} market data
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3">
            <span className="text-xs text-muted-foreground">
              Total Products
            </span>
            <p className="text-xl font-mono font-semibold mt-0.5">
              {stats.product_count.toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3">
            <span className="text-xs text-muted-foreground">
              Avg Price (loose)
            </span>
            <p className="text-xl font-mono font-semibold mt-0.5">
              {stats.avg_loose != null ? `$${stats.avg_loose.toFixed(2)}` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3">
            <span className="text-xs text-muted-foreground">Active Deals</span>
            <p className="text-xl font-mono font-semibold mt-0.5">
              {stats.total_opportunities.toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-4 pb-3">
            <span className="text-xs text-muted-foreground">Avg Margin</span>
            <p className="text-xl font-mono font-semibold mt-0.5">
              {stats.avg_margin != null
                ? `${(stats.avg_margin * 100).toFixed(0)}%`
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top Movers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Top Movers{" "}
            <span className="text-sm font-normal text-muted-foreground">
              Last 30 days
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {movers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No price movement data available yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Product</TableHead>
                  <TableHead className="text-xs">Platform</TableHead>
                  <TableHead className="text-xs text-center">Trend</TableHead>
                  <TableHead className="text-xs text-right">Current</TableHead>
                  <TableHead className="text-xs text-right">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movers.map((m) => {
                  const color = m.change_pct >= 0 ? "#22c55e" : "#ef4444";
                  return (
                    <TableRow key={m.product_id}>
                      <TableCell className="text-sm font-medium max-w-[280px] truncate">
                        <Link
                          href={`/products/${encodeURIComponent(m.product_id)}`}
                          className="hover:underline text-foreground"
                        >
                          {m.title}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {m.platform && (
                          <Badge variant="secondary" className="text-[10px]">
                            {m.platform}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex justify-center">
                          <Sparkline
                            data={sparklineMap[m.product_id] ?? []}
                            color={color}
                            width={80}
                            height={24}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        ${m.last_price.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono text-sm font-semibold"
                        style={{ color }}
                      >
                        {fmtPct(m.change_pct)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Best Deals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Best Deals{" "}
            {deals.length > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs">
                {deals.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {deals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No active deals found in this category.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Product</TableHead>
                  <TableHead className="text-xs">Marketplace</TableHead>
                  <TableHead className="text-xs text-right">Buy</TableHead>
                  <TableHead className="text-xs text-right">Market</TableHead>
                  <TableHead className="text-xs text-right">Profit</TableHead>
                  <TableHead className="text-xs text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deals.map((d, i) => (
                  <TableRow key={`${d.product_id}-${i}`}>
                    <TableCell className="text-sm font-medium max-w-[260px] truncate">
                      <Link
                        href={`/products/${encodeURIComponent(d.product_id)}`}
                        className="hover:underline text-foreground"
                      >
                        {d.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {d.marketplace_name}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      ${d.listing_price_usd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      ${d.market_price_usd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-green-400">
                      +${d.profit_usd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-green-400">
                      {(d.margin_pct * 100).toFixed(0)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Price Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Price Distribution</CardTitle>
          <p className="text-xs text-muted-foreground">
            Products by current loose price range
          </p>
        </CardHeader>
        <CardContent>
          {distribution.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No pricing data available.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={distribution}
                margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.3}
                />
                <XAxis
                  dataKey="bucket"
                  tick={{
                    fontSize: 11,
                    fill: "hsl(var(--muted-foreground))",
                    fontFamily: "monospace",
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fill: "hsl(var(--muted-foreground))",
                    fontFamily: "monospace",
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{
                    color: "hsl(var(--foreground))",
                    fontWeight: 600,
                  }}
                  formatter={(value) => [
                    `${value} products`,
                    "Count",
                  ]}
                />
                <Bar
                  dataKey="count"
                  fill="#eab308"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={60}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top Platforms/Sets */}
      {platforms.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {productType.id === "retro_game"
                ? "Top Platforms"
                : "Top Sets / Platforms"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">
                    {productType.id === "retro_game" ? "Platform" : "Set"}
                  </TableHead>
                  <TableHead className="text-xs text-right">Products</TableHead>
                  <TableHead className="text-xs text-right">
                    Avg Price
                  </TableHead>
                  <TableHead className="text-xs text-right">
                    Avg Volume
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {platforms.map((p) => (
                  <TableRow key={p.platform}>
                    <TableCell className="text-sm font-medium">
                      {p.platform}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {p.product_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {p.avg_price != null ? `$${p.avg_price.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {Math.round(p.avg_volume).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
