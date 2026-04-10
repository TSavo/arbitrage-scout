"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type ProductRow = {
  id: string;
  title: string;
  platform: string | null;
  productTypeId: string;
  salesVolume: number;
  createdAt: string;
  prices: Record<string, number>;
};

function fmt(n: number | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function ProductsClient({ rows }: { rows: ProductRow[] }) {
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<"title" | "volume">("volume");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(col: typeof sortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  }

  const filtered = rows
    .filter((r) =>
      search === "" ||
      r.title.toLowerCase().includes(search.toLowerCase()) ||
      (r.platform ?? "").toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "title") return dir * a.title.localeCompare(b.title);
      return dir * (a.salesVolume - b.salesVolume);
    });

  const sortIcon = (col: typeof sortCol) =>
    sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search title or platform…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm bg-card border border-border rounded px-3 py-1.5 text-foreground placeholder:text-muted-foreground w-72 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead
                className="text-xs cursor-pointer hover:text-foreground"
                onClick={() => handleSort("title")}
              >
                Title{sortIcon("title")}
              </TableHead>
              <TableHead className="text-xs">Platform</TableHead>
              <TableHead className="text-xs">Type</TableHead>
              <TableHead className="text-xs text-right">Loose</TableHead>
              <TableHead className="text-xs text-right">CIB</TableHead>
              <TableHead className="text-xs text-right">New</TableHead>
              <TableHead
                className="text-xs text-right cursor-pointer hover:text-foreground"
                onClick={() => handleSort("volume")}
              >
                Sales Vol{sortIcon("volume")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground py-10 text-sm"
                >
                  No products found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((row) => (
              <TableRow key={row.id} className="hover:bg-accent/20 transition-colors">
                <TableCell className="max-w-[300px]">
                  <span className="text-sm truncate block">{row.title}</span>
                </TableCell>
                <TableCell>
                  {row.platform ? (
                    <Badge variant="outline" className="text-xs">
                      {row.platform}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground font-mono">
                    {row.productTypeId}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(row.prices["loose"])}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(row.prices["cib"] ?? row.prices["CIB"])}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(row.prices["new"] ?? row.prices["New"])}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-muted-foreground">
                  {row.salesVolume.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
