"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

type WatchlistItem = {
  id: number;
  productId: string;
  targetPricePct: number;
  condition: string;
  createdAt: string;
  triggeredAt: string | null;
  active: boolean;
  notes: string | null;
  productTitle: string;
  platform: string | null;
  marketPrice: number | null;
  targetPrice: number | null;
  triggered: boolean;
  gapPct: number | null;
};

type Product = {
  id: string;
  title: string;
  platform: string | null;
};

function fmt(n: number | null) {
  if (n == null) return "\u2014";
  return `$${n.toFixed(2)}`;
}

export function WatchlistClient({
  items,
  products,
}: {
  items: WatchlistItem[];
  products: Product[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [targetPct, setTargetPct] = useState("20");
  const [condition, setCondition] = useState("loose");
  const [adding, setAdding] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const filteredProducts = productSearch.length >= 2
    ? products.filter(
        (p) =>
          p.title.toLowerCase().includes(productSearch.toLowerCase()) ||
          (p.platform ?? "").toLowerCase().includes(productSearch.toLowerCase()),
      ).slice(0, 20)
    : [];

  const filteredItems = items.filter(
    (item) =>
      search === "" ||
      item.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      (item.platform ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  async function handleAdd() {
    if (!selectedProductId || !targetPct) return;
    setAdding(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: selectedProductId,
          targetPricePct: Number(targetPct),
          condition,
        }),
      });
      if (res.ok) {
        setProductSearch("");
        setSelectedProductId("");
        setTargetPct("20");
        setCondition("loose");
        router.refresh();
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(id: number, currentActive: boolean) {
    await fetch(`/api/watchlist/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !currentActive }),
    });
    router.refresh();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/watchlist/${id}`, { method: "DELETE" });
    setConfirmDelete(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Add to Watchlist */}
      <div className="rounded-md border border-border p-4 bg-card space-y-3">
        <h3 className="text-sm font-semibold text-foreground">
          Add to Watchlist
        </h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[250px]">
            <label className="text-xs text-muted-foreground block mb-1">
              Product
            </label>
            <input
              type="text"
              placeholder="Search products..."
              value={productSearch}
              onChange={(e) => {
                setProductSearch(e.target.value);
                setSelectedProductId("");
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              className="text-sm bg-background border border-border rounded px-3 py-1.5 text-foreground placeholder:text-muted-foreground w-full focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {showDropdown && filteredProducts.length > 0 && !selectedProductId && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg max-h-60 overflow-auto">
                {filteredProducts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex justify-between items-center"
                    onClick={() => {
                      setSelectedProductId(p.id);
                      setProductSearch(p.title);
                      setShowDropdown(false);
                    }}
                  >
                    <span className="truncate">{p.title}</span>
                    {p.platform && (
                      <Badge variant="outline" className="text-xs ml-2 shrink-0">
                        {p.platform}
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Target %
            </label>
            <input
              type="number"
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              className="text-sm bg-background border border-border rounded px-3 py-1.5 text-foreground w-20 focus:outline-none focus:ring-1 focus:ring-ring"
              min="1"
              max="99"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Condition
            </label>
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              className="text-sm bg-background border border-border rounded px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="loose">Loose</option>
              <option value="cib">CIB</option>
              <option value="new_sealed">New / Sealed</option>
            </select>
          </div>

          <Button
            onClick={handleAdd}
            disabled={!selectedProductId || adding}
            size="sm"
          >
            {adding ? "Adding..." : "Add"}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Filter */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Filter watchlist..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm bg-card border border-border rounded px-3 py-1.5 text-foreground placeholder:text-muted-foreground w-72 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="text-xs text-muted-foreground">
          {filteredItems.length} of {items.length}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="text-xs">Product</TableHead>
              <TableHead className="text-xs">Platform</TableHead>
              <TableHead className="text-xs">Condition</TableHead>
              <TableHead className="text-xs text-right">Market Price</TableHead>
              <TableHead className="text-xs text-right">Target %</TableHead>
              <TableHead className="text-xs text-right">Target Price</TableHead>
              <TableHead className="text-xs text-center">Status</TableHead>
              <TableHead className="text-xs">Added</TableHead>
              <TableHead className="text-xs text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center text-muted-foreground py-10 text-sm"
                >
                  No watchlist items. Add a product above to start tracking.
                </TableCell>
              </TableRow>
            )}
            {filteredItems.map((item) => (
              <TableRow
                key={item.id}
                className={`transition-colors ${
                  item.triggered && item.active
                    ? "bg-green-950/30 hover:bg-green-950/40"
                    : "hover:bg-accent/20"
                } ${!item.active ? "opacity-50" : ""}`}
              >
                <TableCell className="max-w-[250px]">
                  <Link
                    href={`/products/${encodeURIComponent(item.productId)}`}
                    className="text-sm truncate block text-blue-400 hover:underline"
                  >
                    {item.productTitle}
                  </Link>
                </TableCell>
                <TableCell>
                  {item.platform ? (
                    <Badge variant="outline" className="text-xs">
                      {item.platform}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {item.condition}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(item.marketPrice)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {item.targetPricePct}%
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(item.targetPrice)}
                </TableCell>
                <TableCell className="text-center">
                  {!item.active ? (
                    <Badge variant="secondary" className="text-xs">
                      Paused
                    </Badge>
                  ) : item.triggered ? (
                    <Badge className="text-xs bg-green-600 hover:bg-green-700 text-white">
                      Triggered
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      Watching
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => handleToggle(item.id, item.active)}
                    >
                      {item.active ? "Pause" : "Resume"}
                    </Button>
                    {confirmDelete === item.id ? (
                      <div className="flex gap-1">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7 text-xs px-2"
                          onClick={() => handleDelete(item.id)}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs px-2"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2 text-destructive hover:text-destructive"
                        onClick={() => setConfirmDelete(item.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
