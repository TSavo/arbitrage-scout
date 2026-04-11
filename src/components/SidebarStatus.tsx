"use client";

import { useEffect, useState } from "react";

type SystemState = "running" | "idle" | "error";

export function SidebarStatus() {
  const [state, setState] = useState<SystemState>("idle");

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/actions/status");
        if (!res.ok || !mounted) return;
        const data = await res.json();

        const isRunning = Object.values(data.running ?? {}).some(
          (v) => v === true,
        );
        const hasError = Object.values(data.lastRun ?? {}).some(
          (v: unknown) => v && typeof v === "object" && "error" in (v as Record<string, unknown>) && (v as Record<string, unknown>).error,
        );

        if (isRunning) setState("running");
        else if (hasError) setState("error");
        else setState("idle");
      } catch {
        // ignore
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const dotColor =
    state === "running"
      ? "#34d399"
      : state === "error"
        ? "#fb7185"
        : "#34d399";

  const label =
    state === "running"
      ? "scanning"
      : state === "error"
        ? "error"
        : "live";

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        {state === "running" && (
          <div
            className="absolute inset-0 w-1.5 h-1.5 rounded-full animate-ping"
            style={{ background: dotColor, opacity: 0.4 }}
          />
        )}
      </div>
      <span
        className="text-[10px]"
        style={{ color: "#52525e", fontFamily: "var(--font-mono)" }}
      >
        {label}
      </span>
    </div>
  );
}
