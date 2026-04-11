"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { PriceChart, type PriceDataPoint } from "@/components/PriceChart";

export type LotItem = {
  productTitle: string;
  productPlatform: string;
  condition: string;
  conditionDetails: Record<string, unknown>;
  estimatedValueUsd: number;
  confidence: number;
};

export type PriceComparison = {
  source: string;
  condition: string;
  priceUsd: number;
  recordedAt: string;
};

export type OpportunityRow = {
  id: number;
  productId: string;
  listingTitle: string;
  productTitle: string;
  productPlatform: string;
  marketplaceName: string;
  listingPriceUsd: number;
  listingTotalPrice: number;
  listingShipping: number;
  marketPriceUsd: number;
  profitUsd: number;
  marginPct: number;
  potentialProfitUsd: number | null;
  potentialMarginPct: number | null;
  status: string;
  flags: string[];
  foundAt: string;
  url: string | null;
  condition: string;
  confidence: number;
  marketPriceCondition: string;
  marketPriceSource: string;
  feesUsd: number;
  isLot: boolean;
  lotItems: LotItem[];
  priceComparisons: PriceComparison[];
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
  }).format(n);
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "new") return "default";
  if (status === "reviewed") return "secondary";
  if (status === "purchased") return "outline";
  return "destructive";
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Renders relative time only on client to avoid hydration mismatch */
function TimeAgo({ ts }: { ts: string }) {
  const [text, setText] = useState(ts.slice(0, 10));
  useEffect(() => {
    setText(timeAgo(ts));
    const interval = setInterval(() => setText(timeAgo(ts)), 60000);
    return () => clearInterval(interval);
  }, [ts]);
  return <>{text}</>;
}

function conditionBadge(cond: string) {
  const colors: Record<string, string> = {
    loose: "bg-yellow-500/20 text-yellow-300",
    cib: "bg-blue-500/20 text-blue-300",
    new_sealed: "bg-green-500/20 text-green-300",
    graded: "bg-purple-500/20 text-purple-300",
  };
  return colors[cond] ?? "bg-gray-500/20 text-gray-300";
}

const STATUS_OPTIONS = ["all", "new", "reviewed", "purchased", "passed"];

export function OpportunitiesTable({ rows }: { rows: OpportunityRow[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [minProfit, setMinProfit] = useState(0);
  const [sortCol, setSortCol] = useState<"profit" | "margin" | "found">("found");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pending, startTransition] = useTransition();

  function handleSort(col: typeof sortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  async function updateStatus(id: number, status: string) {
    startTransition(async () => {
      await fetch(`/api/opportunities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      window.location.reload();
    });
  }

  const filtered = rows
    .filter((r) => filterStatus === "all" || r.status === filterStatus)
    .filter((r) => r.profitUsd >= minProfit)
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "profit") return dir * (a.profitUsd - b.profitUsd);
      if (sortCol === "margin") return dir * (a.marginPct - b.marginPct);
      return dir * (new Date(a.foundAt).getTime() - new Date(b.foundAt).getTime());
    });

  const sortIcon = (col: typeof sortCol) =>
    sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground">
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">Min $</label>
          <input type="number" value={minProfit} min={0}
            onChange={(e) => setMinProfit(Number(e.target.value))}
            className="text-xs bg-card border border-border rounded px-2 py-1 w-16 text-foreground" />
        </div>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} of {rows.length}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="text-xs w-[250px]">Product</TableHead>
              <TableHead className="text-xs">Source</TableHead>
              <TableHead className="text-xs text-right">Buy</TableHead>
              <TableHead className="text-xs text-right">Market</TableHead>
              <TableHead className="text-xs text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("profit")}>Profit{sortIcon("profit")}</TableHead>
              <TableHead className="text-xs text-right">Potential</TableHead>
              <TableHead className="text-xs text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("margin")}>Margin{sortIcon("margin")}</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs cursor-pointer hover:text-foreground"
                onClick={() => handleSort("found")}>Found{sortIcon("found")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <Fragment key={row.id}>
                <TableRow className="cursor-pointer hover:bg-accent/20"
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                  <TableCell>
                    <div className="space-y-0.5">
                      <Link
                        href={`/products/${encodeURIComponent(row.productId)}`}
                        className="text-sm font-medium block truncate max-w-[250px] text-blue-400 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {row.productTitle}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {row.productPlatform}
                        {row.isLot && <Badge variant="outline" className="ml-1 text-[10px]">LOT ({row.lotItems.length})</Badge>}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{row.marketplaceName}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(row.listingPriceUsd)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(row.marketPriceUsd)}</TableCell>
                  <TableCell className="text-right font-mono text-sm font-semibold text-green-400">
                    {fmt(row.profitUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.potentialProfitUsd != null && row.potentialProfitUsd !== row.profitUsd ? (
                      <span style={{ color: "#38bdf8" }}>{fmt(row.potentialProfitUsd)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmtPct(row.marginPct)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)} className="text-xs">{row.status}</Badge>
                    {row.flags.map((f) => (
                      <Badge key={f} variant="secondary" className="text-[10px] ml-1">{f}</Badge>
                    ))}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground"><TimeAgo ts={row.foundAt} /></TableCell>
                </TableRow>

                {expanded === row.id && (
                  <TableRow className="bg-muted/5">
                    <TableCell colSpan={9} className="p-4">
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        {/* Lot Breakdown */}
                        {row.lotItems.length > 0 && (
                          <Card className="bg-card/50">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm">
                                {row.isLot ? "Lot Breakdown" : "Item Details"}
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2">
                              {row.lotItems.map((item, i) => (
                                <div key={i} className="flex justify-between items-center text-xs">
                                  <div>
                                    <span className="font-medium">{item.productTitle}</span>
                                    <span className="text-muted-foreground ml-1">({item.productPlatform})</span>
                                    <span className={`ml-1 px-1 py-0.5 rounded text-[10px] ${conditionBadge(item.condition)}`}>
                                      {item.condition}
                                    </span>
                                  </div>
                                  <div className="text-right">
                                    <span className="font-mono font-medium">{fmt(item.estimatedValueUsd)}</span>
                                    <span className="text-muted-foreground ml-1">
                                      ({(item.confidence * 100).toFixed(0)}%)
                                    </span>
                                  </div>
                                </div>
                              ))}
                              {row.isLot && row.lotItems.length > 1 && (
                                <>
                                  <Separator />
                                  <div className="flex justify-between text-xs font-semibold">
                                    <span>Total lot value</span>
                                    <span className="font-mono">
                                      {fmt(row.lotItems.reduce((s, i) => s + i.estimatedValueUsd, 0))}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>Listing price</span>
                                    <span className="font-mono">{fmt(row.listingTotalPrice + row.listingShipping)}</span>
                                  </div>
                                </>
                              )}
                            </CardContent>
                          </Card>
                        )}

                        {/* Price Chart + Comparisons */}
                        <Card className="bg-card/50">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm">
                              <Link href={`/products/${encodeURIComponent(row.productId)}`}
                                className="text-blue-400 hover:underline"
                                onClick={(e) => e.stopPropagation()}>
                                Price History &rarr;
                              </Link>
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <OpportunityPriceChart productId={row.productId} listingPrice={row.listingPriceUsd} />
                            {row.priceComparisons.length > 0 && (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="text-[10px] p-1">Source</TableHead>
                                    <TableHead className="text-[10px] p-1">Condition</TableHead>
                                    <TableHead className="text-[10px] p-1 text-right">Price</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {row.priceComparisons
                                    .sort((a, b) => a.priceUsd - b.priceUsd)
                                    .map((pc, i) => (
                                      <TableRow key={i}>
                                        <TableCell className="text-xs p-1">{pc.source}</TableCell>
                                        <TableCell className="p-1">
                                          <span className={`text-[10px] px-1 py-0.5 rounded ${conditionBadge(pc.condition)}`}>
                                            {pc.condition}
                                          </span>
                                        </TableCell>
                                        <TableCell className="text-xs p-1 text-right font-mono">
                                          {fmt(pc.priceUsd)}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                </TableBody>
                              </Table>
                            )}
                          </CardContent>
                        </Card>

                        {/* Actions + Details */}
                        <Card className="bg-card/50">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Details</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {row.url && (
                              <a href={row.url} target="_blank" rel="noopener noreferrer"
                                className="text-blue-400 hover:underline text-xs block"
                                onClick={(e) => e.stopPropagation()}>
                                View on {row.marketplaceName} →
                              </a>
                            )}
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div>
                                <span className="text-muted-foreground">Condition</span>
                                <p className={`mt-0.5 px-1 py-0.5 rounded inline-block ${conditionBadge(row.condition)}`}>
                                  {row.condition}
                                </p>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Confidence</span>
                                <p className="font-mono mt-0.5">{(row.confidence * 100).toFixed(0)}%</p>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Price source</span>
                                <p className="mt-0.5">{row.marketPriceSource}</p>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Est. fees</span>
                                <p className="font-mono mt-0.5">{fmt(row.feesUsd)}</p>
                              </div>
                            </div>
                            <Separator />
                            <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                              {row.status !== "reviewed" && (
                                <Button size="sm" variant="secondary" disabled={pending}
                                  onClick={() => updateStatus(row.id, "reviewed")}>Reviewed</Button>
                              )}
                              {row.status !== "purchased" && (
                                <Button size="sm" variant="outline" disabled={pending}
                                  onClick={() => updateStatus(row.id, "purchased")}>Purchased</Button>
                              )}
                              {row.status !== "passed" && (
                                <Button size="sm" variant="destructive" disabled={pending}
                                  onClick={() => updateStatus(row.id, "passed")}>Pass</Button>
                              )}
                              {row.status !== "new" && (
                                <Button size="sm" variant="ghost" disabled={pending}
                                  onClick={() => updateStatus(row.id, "new")}>Reset</Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Need Fragment import
import { Fragment } from "react";

function OpportunityPriceChart({ productId, listingPrice }: { productId: string; listingPrice: number }) {
  const [chartData, setChartData] = useState<PriceDataPoint[]>([]);
  const [seriesKeys, setSeriesKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/products/${encodeURIComponent(productId)}/prices`)
      .then((r) => r.json())
      .then((rows: { source: string; condition: string; priceUsd: number; recordedAt: string }[]) => {
        const dateMap = new Map<string, Record<string, number>>();
        const keys = new Set<string>();
        for (const p of rows) {
          const date = p.recordedAt.slice(0, 10);
          const key = `${p.source} ${p.condition}`;
          keys.add(key);
          if (!dateMap.has(date)) dateMap.set(date, {});
          dateMap.get(date)![key] = p.priceUsd;
        }
        const data = Array.from(dateMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, vals]) => ({ date, ...vals }));
        setChartData(data);
        setSeriesKeys(Array.from(keys));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [productId]);

  if (loading) return <div className="text-xs text-muted-foreground py-4">Loading chart...</div>;
  if (!chartData.length) return null;

  return (
    <div className="mb-3">
      <PriceChart data={chartData} seriesKeys={seriesKeys} height={180} />
    </div>
  );
}
