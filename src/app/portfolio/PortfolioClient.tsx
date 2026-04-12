"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

export type PortfolioDeal = {
  id: number;
  productId: string;
  productTitle: string;
  productPlatform: string;
  taxonomyNodeLabel: string;
  buyPrice: number;
  currentMarketPrice: number;
  predictedProfit: number;
  actualProfit: number | null;
  unrealizedProfit: number | null;
  salePriceUsd: number | null;
  saleDate: string | null;
  actualFeesUsd: number | null;
  feesUsd: number;
  foundAt: string;
  isSold: boolean;
};

export type CategoryBreakdown = {
  category: string;
  realized: number;
  unrealized: number;
};

export type PortfolioSummary = {
  totalInvested: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalReturn: number;
  totalItems: number;
  soldItems: number;
};

function fmt(n: number) {
  return `$${n.toFixed(2)}`;
}

function pnlColor(n: number) {
  return n >= 0 ? "text-green-400" : "text-red-400";
}

type Props = {
  summary: PortfolioSummary;
  categoryBreakdown: CategoryBreakdown[];
  deals: PortfolioDeal[];
};

export function PortfolioClient({ summary, categoryBreakdown, deals }: Props) {
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Invested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{fmt(summary.totalInvested)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.totalItems} items ({summary.soldItems} sold)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Realized P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${pnlColor(summary.realizedPnl)}`}>
              {summary.realizedPnl >= 0 ? "+" : ""}
              {fmt(summary.realizedPnl)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              From {summary.soldItems} sold items
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unrealized P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${pnlColor(summary.unrealizedPnl)}`}>
              {summary.unrealizedPnl >= 0 ? "+" : ""}
              {fmt(summary.unrealizedPnl)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.totalItems - summary.soldItems} items held
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Return
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${pnlColor(summary.totalReturn)}`}>
              {summary.totalReturn >= 0 ? "+" : ""}
              {summary.totalReturn.toFixed(1)}%
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Combined realized + unrealized
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Category Breakdown Chart */}
      {categoryBreakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              P&L by Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={categoryBreakdown}
                margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.3}
                />
                <XAxis
                  dataKey="category"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickFormatter={(v: number) => `$${v}`}
                  width={60}
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
                  formatter={(value) => [`$${Number(value).toFixed(2)}`]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="realized"
                  name="Realized"
                  fill="#22c55e"
                  stackId="pnl"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="unrealized"
                  name="Unrealized"
                  fill="#3b82f6"
                  stackId="pnl"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Deals Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Deals ({deals.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Platform</th>
                  <th className="px-4 py-3 font-medium text-right">Buy Price</th>
                  <th className="px-4 py-3 font-medium text-right">Market Price</th>
                  <th className="px-4 py-3 font-medium text-right">Predicted</th>
                  <th className="px-4 py-3 font-medium text-right">Actual P&L</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => (
                  <DealRow key={deal.id} deal={deal} />
                ))}
                {deals.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      No purchased opportunities yet. Mark opportunities as
                      &quot;purchased&quot; to track them here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DealRow({ deal }: { deal: PortfolioDeal }) {
  const router = useRouter();
  const [showSaleForm, setShowSaleForm] = useState(false);
  const [salePrice, setSalePrice] = useState("");
  const [saleDate, setSaleDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [saleFees, setSaleFees] = useState("");
  const [saving, setSaving] = useState(false);

  const profitDisplay = deal.isSold
    ? deal.actualProfit
    : deal.unrealizedProfit;

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        salePriceUsd: parseFloat(salePrice),
        saleDate,
      };
      if (saleFees) {
        body.actualFeesUsd = parseFloat(saleFees);
      }
      await fetch(`/api/opportunities/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setShowSaleForm(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr className="border-b border-border/50 hover:bg-muted/30 transition-colors">
        <td className="px-4 py-3">
          <Link
            href={`/products/${encodeURIComponent(deal.productId)}`}
            className="text-sm font-medium hover:underline"
          >
            {deal.productTitle}
          </Link>
        </td>
        <td className="px-4 py-3">
          {deal.productPlatform && (
            <Badge variant="secondary">{deal.productPlatform}</Badge>
          )}
        </td>
        <td className="px-4 py-3 text-right font-mono">
          {fmt(deal.buyPrice)}
        </td>
        <td className="px-4 py-3 text-right font-mono">
          {fmt(deal.currentMarketPrice)}
        </td>
        <td className="px-4 py-3 text-right font-mono">
          <span className={pnlColor(deal.predictedProfit)}>
            {fmt(deal.predictedProfit)}
          </span>
        </td>
        <td className="px-4 py-3 text-right font-mono">
          {profitDisplay != null ? (
            <span className={pnlColor(profitDisplay)}>
              {profitDisplay >= 0 ? "+" : ""}
              {fmt(profitDisplay)}
            </span>
          ) : (
            <span className="text-muted-foreground">--</span>
          )}
        </td>
        <td className="px-4 py-3">
          {deal.isSold ? (
            <Badge variant="default">Sold</Badge>
          ) : (
            <Badge variant="outline">Holding</Badge>
          )}
        </td>
        <td className="px-4 py-3">
          {!deal.isSold && (
            <button
              onClick={() => setShowSaleForm(!showSaleForm)}
              className="text-xs px-2 py-1 rounded bg-accent hover:bg-accent/80 text-accent-foreground transition-colors"
            >
              Record Sale
            </button>
          )}
        </td>
      </tr>
      {showSaleForm && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={8} className="px-4 py-3">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-muted-foreground">
                Sale Price
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  placeholder="0.00"
                  className="ml-1 w-24 px-2 py-1 rounded bg-background border border-border text-sm font-mono"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Date
                <input
                  type="date"
                  value={saleDate}
                  onChange={(e) => setSaleDate(e.target.value)}
                  className="ml-1 w-36 px-2 py-1 rounded bg-background border border-border text-sm"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Fees
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={saleFees}
                  onChange={(e) => setSaleFees(e.target.value)}
                  placeholder="0.00"
                  className="ml-1 w-20 px-2 py-1 rounded bg-background border border-border text-sm font-mono"
                />
              </label>
              <button
                onClick={handleSave}
                disabled={saving || !salePrice}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => setShowSaleForm(false)}
                className="text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
