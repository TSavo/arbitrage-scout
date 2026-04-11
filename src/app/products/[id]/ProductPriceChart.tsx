"use client";

import { PriceChart, type PriceDataPoint } from "@/components/PriceChart";

type Props = {
  data: PriceDataPoint[];
  seriesKeys: string[];
};

export function ProductPriceChart({ data, seriesKeys }: Props) {
  return <PriceChart data={data} seriesKeys={seriesKeys} height={350} />;
}
