"use client";

import { ResponsiveContainer, LineChart, Line } from "recharts";

type Props = {
  data: { value: number }[];
  color?: string;
  width?: number;
  height?: number;
};

export function Sparkline({ data, color = "#eab308", width = 80, height = 24 }: Props) {
  if (data.length < 2) return null;

  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
