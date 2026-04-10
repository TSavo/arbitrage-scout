"use client";

import { useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export type OpportunityRow = {
  id: number;
  listingTitle: string;
  marketplaceName: string;
  listingPriceUsd: number;
  marketPriceUsd: number;
  profitUsd: number;
  marginPct: number;
  status: string;
  flags: string[];
  foundAt: string;
  url: string | null;
  condition: string;
  confidence: number;
  marketPriceCondition: string;
  marketPriceSource: string;
  feesUsd: number;
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function statusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "new") return "default";
  if (status === "reviewed") return "secondary";
  if (status === "purchased") return "outline";
  if (status === "passed") return "destructive";
  return "secondary";
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS_OPTIONS = ["all", "new", "reviewed", "purchased", "passed"];
const MARKETPLACE_OPTIONS = ["all", "ebay", "shopgoodwill", "pricecharting"];

export function OpportunitiesTable({ rows }: { rows: OpportunityRow[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterMarketplace, setFilterMarketplace] = useState("all");
  const [minProfit, setMinProfit] = useState(0);
  const [sortCol, setSortCol] = useState<"profit" | "margin" | "found">("found");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pending, startTransition] = useTransition();

  function handleSort(col: typeof sortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  async function updateStatus(id: number, status: string) {
    startTransition(async () => {
      await fetch(`/api/opportunities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      // Naive: reload the page for fresh data
      window.location.reload();
    });
  }

  const filtered = rows
    .filter((r) => filterStatus === "all" || r.status === filterStatus)
    .filter(
      (r) =>
        filterMarketplace === "all" ||
        r.marketplaceName.toLowerCase().includes(filterMarketplace)
    )
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Status</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Marketplace</label>
          <select
            value={filterMarketplace}
            onChange={(e) => setFilterMarketplace(e.target.value)}
            className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground"
          >
            {MARKETPLACE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Min profit</label>
          <input
            type="number"
            value={minProfit}
            min={0}
            onChange={(e) => setMinProfit(Number(e.target.value))}
            className="text-xs bg-card border border-border rounded px-2 py-1 w-20 text-foreground"
          />
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
              <TableHead className="text-xs">Product</TableHead>
              <TableHead className="text-xs">Marketplace</TableHead>
              <TableHead className="text-xs text-right">Listed</TableHead>
              <TableHead className="text-xs text-right">Market</TableHead>
              <TableHead
                className="text-xs text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("profit")}
              >
                Profit{sortIcon("profit")}
              </TableHead>
              <TableHead
                className="text-xs text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("margin")}
              >
                Margin{sortIcon("margin")}
              </TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs">Flags</TableHead>
              <TableHead
                className="text-xs cursor-pointer hover:text-foreground"
                onClick={() => handleSort("found")}
              >
                Found{sortIcon("found")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center text-muted-foreground py-10 text-sm"
                >
                  No opportunities match your filters.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((row) => (
              <>
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-accent/20 transition-colors"
                  onClick={() =>
                    setExpanded(expanded === row.id ? null : row.id)
                  }
                >
                  <TableCell className="max-w-[200px]">
                    <span className="text-sm truncate block">{row.listingTitle}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {row.marketplaceName}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmt(row.listingPriceUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmt(row.marketPriceUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-semibold text-green-400">
                    {fmt(row.profitUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtPct(row.marginPct)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)} className="text-xs">
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {row.flags.map((f) => (
                        <Badge key={f} variant="secondary" className="text-xs">
                          {f}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {timeAgo(row.foundAt)}
                  </TableCell>
                </TableRow>

                {expanded === row.id && (
                  <TableRow key={`${row.id}-expand`} className="bg-muted/10">
                    <TableCell colSpan={9} className="py-4 px-6">
                      <div className="grid grid-cols-2 gap-6 text-sm">
                        <div className="space-y-2">
                          <div>
                            <span className="text-muted-foreground text-xs">
                              Listing URL
                            </span>
                            <p className="mt-0.5">
                              {row.url ? (
                                <a
                                  href={row.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:underline text-xs break-all"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {row.url}
                                </a>
                              ) : (
                                <span className="text-muted-foreground text-xs">
                                  No URL
                                </span>
                              )}
                            </p>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">
                              Condition
                            </span>
                            <p className="font-mono text-xs mt-0.5">
                              {row.condition}
                            </p>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">
                              Confidence
                            </span>
                            <p className="font-mono text-xs mt-0.5">
                              {(row.confidence * 100).toFixed(0)}%
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <span className="text-muted-foreground text-xs">
                              Market price source
                            </span>
                            <p className="font-mono text-xs mt-0.5">
                              {row.marketPriceSource} / {row.marketPriceCondition}
                            </p>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">
                              Fees
                            </span>
                            <p className="font-mono text-xs mt-0.5">
                              {fmt(row.feesUsd)}
                            </p>
                          </div>
                        </div>
                      </div>
                      <Separator className="my-3" />
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        {row.status !== "reviewed" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            onClick={() => updateStatus(row.id, "reviewed")}
                          >
                            Mark Reviewed
                          </Button>
                        )}
                        {row.status !== "purchased" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => updateStatus(row.id, "purchased")}
                          >
                            Mark Purchased
                          </Button>
                        )}
                        {row.status !== "passed" && (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={pending}
                            onClick={() => updateStatus(row.id, "passed")}
                          >
                            Pass
                          </Button>
                        )}
                        {row.status !== "new" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => updateStatus(row.id, "new")}
                          >
                            Reset to New
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
