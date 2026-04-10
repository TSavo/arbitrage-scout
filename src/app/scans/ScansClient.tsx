"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

export function ScanButtons() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  async function runScan(type: "scan" | "stock") {
    startTransition(async () => {
      setMessage(null);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        });
        const data = await res.json();
        setMessage(`Started: ${JSON.stringify(data)}`);
      } catch (e) {
        setMessage(`Error: ${e}`);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        onClick={() => runScan("scan")}
        disabled={pending}
      >
        {pending ? "Starting…" : "Run Scan"}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => runScan("stock")}
        disabled={pending}
      >
        {pending ? "Starting…" : "Run Stock"}
      </Button>
      {message && (
        <span className="text-xs text-muted-foreground font-mono">
          {message}
        </span>
      )}
    </div>
  );
}
