"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

export type PriceDataPoint = {
  date: string;
  [seriesKey: string]: number | string;
};

const CONDITION_COLORS: Record<string, string> = {
  loose: "#eab308",
  cib: "#3b82f6",
  new_sealed: "#22c55e",
  graded: "#a855f7",
  box_only: "#f97316",
  manual_only: "#ec4899",
  foil: "#06b6d4",
  in_box: "#3b82f6",
};

const SOURCE_COLORS: Record<string, string> = {
  pricecharting: "#eab308",
  tcgplayer: "#ef4444",
  ebay: "#3b82f6",
  shopgoodwill: "#22c55e",
  discogs: "#a855f7",
  hibid: "#f97316",
};

function formatLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickColor(key: string, index: number): string {
  // Try condition color first, then source color, then fallback
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(CONDITION_COLORS)) {
    if (lower.includes(k)) return v;
  }
  for (const [k, v] of Object.entries(SOURCE_COLORS)) {
    if (lower.includes(k)) return v;
  }
  const fallback = ["#eab308", "#3b82f6", "#22c55e", "#a855f7", "#ef4444", "#f97316", "#ec4899", "#06b6d4"];
  return fallback[index % fallback.length];
}

type Props = {
  data: PriceDataPoint[];
  seriesKeys: string[];
  height?: number;
};

export function PriceChart({ data, seriesKeys, height = 300 }: Props) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-sm" style={{ height }}>
        No price history available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f1f28" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "#6b6b76", fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: "#1f1f28" }}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#6b6b76", fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: "#1f1f28" }}
          tickFormatter={(v: number) => `$${v}`}
          width={55}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#101016",
            border: "1px solid #27272e",
            borderRadius: 6,
            fontSize: 12,
            color: "#e2e2e8",
            fontFamily: "var(--font-mono)",
          }}
          labelStyle={{ color: "#e2e2e8", fontWeight: 600, marginBottom: 4 }}
          itemStyle={{ color: "#a1a1aa", padding: 0 }}
          formatter={(value) => [`$${Number(value).toFixed(2)}`]}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#8b8b96", paddingTop: 8 }}
          formatter={(value: string) => formatLabel(value)}
        />
        {seriesKeys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={pickColor(key, i)}
            strokeWidth={2}
            dot={false}
            connectNulls
            name={key}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
