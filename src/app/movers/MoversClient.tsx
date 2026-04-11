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

type Mover = {
  product_id: string;
  first_price: number;
  last_price: number;
  change_pct: number;
  change_usd: number;
  title: string;
  platform: string | null;
  product_type_id: string;
};

type Props = {
  risers: Mover[];
  fallers: Mover[];
  sparklineMap: Record<string, { value: number }[]>;
  currentWindow: string;
};

const WINDOWS = ["7d", "30d", "90d"] as const;

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function MoverTable({
  movers,
  sparklineMap,
  direction,
}: {
  movers: Mover[];
  sparklineMap: Record<string, { value: number }[]>;
  direction: "up" | "down";
}) {
  const color = direction === "up" ? "#22c55e" : "#ef4444";

  if (movers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No {direction === "up" ? "risers" : "fallers"} found for this time
        window.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs">Product</TableHead>
          <TableHead className="text-xs">Platform</TableHead>
          <TableHead className="text-xs text-center">Trend</TableHead>
          <TableHead className="text-xs text-right">Start</TableHead>
          <TableHead className="text-xs text-right">Current</TableHead>
          <TableHead className="text-xs text-right">Change</TableHead>
          <TableHead className="text-xs text-right">%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {movers.map((m) => (
          <TableRow key={`${m.product_id}-${m.change_pct}`}>
            <TableCell className="text-sm font-medium max-w-[280px] truncate">
              <Link
                href={`/products/${m.product_id}`}
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
            <TableCell className="text-right font-mono text-sm text-muted-foreground">
              ${m.first_price.toFixed(2)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              ${m.last_price.toFixed(2)}
            </TableCell>
            <TableCell
              className="text-right font-mono text-sm"
              style={{ color }}
            >
              {fmtUsd(m.change_usd)}
            </TableCell>
            <TableCell
              className="text-right font-mono text-sm font-semibold"
              style={{ color }}
            >
              {fmtPct(m.change_pct)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function MoversClient({
  risers,
  fallers,
  sparklineMap,
  currentWindow,
}: Props) {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Price Movers
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Biggest price changes over the selected time window
          </p>
        </div>
        <div className="flex gap-1 bg-muted rounded-md p-1">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={`/movers?window=${w}`}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                currentWindow === w
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {w}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <span style={{ color: "#22c55e" }}>&#9650;</span> Rising
            <span className="text-sm font-normal text-muted-foreground">
              Top {risers.length} gainers
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MoverTable
            movers={risers}
            sparklineMap={sparklineMap}
            direction="up"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <span style={{ color: "#ef4444" }}>&#9660;</span> Falling
            <span className="text-sm font-normal text-muted-foreground">
              Top {fallers.length} decliners
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MoverTable
            movers={fallers}
            sparklineMap={sparklineMap}
            direction="down"
          />
        </CardContent>
      </Card>
    </div>
  );
}
