"use client";

import { useEffect, useState } from "react";

interface StatusData {
  running: Record<string, boolean>;
  lastRun: Record<string, { at: string; error?: string } | null>;
}

export function LiveStats() {
  const [status, setStatus] = useState<StatusData | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/actions/status");
        if (res.ok && mounted) {
          setStatus(await res.json());
        }
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

  if (!status) return null;

  const runningJobs = Object.entries(status.running ?? {}).filter(
    ([, v]) => v,
  );
  const hasErrors = Object.values(status.lastRun ?? {}).some(
    (v) => v?.error,
  );

  if (runningJobs.length === 0 && !hasErrors) return null;

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-4 py-2.5 border"
      style={{
        background: runningJobs.length > 0
          ? "linear-gradient(135deg, #0a1f15, #0f2b1c)"
          : "linear-gradient(135deg, #1f0a0a, #2b0f0f)",
        borderColor: runningJobs.length > 0 ? "#1a3d2a" : "#3d1a1a",
      }}
    >
      {runningJobs.length > 0 ? (
        <>
          <div className="relative">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: "#34d399" }}
            />
            <div
              className="absolute inset-0 w-2 h-2 rounded-full animate-ping"
              style={{ background: "#34d399", opacity: 0.4 }}
            />
          </div>
          <span
            className="text-[12px] font-medium"
            style={{ color: "#34d399", fontFamily: "var(--font-mono)" }}
          >
            {runningJobs.map(([k]) => k).join(", ")} running...
          </span>
        </>
      ) : hasErrors ? (
        <>
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: "#fb7185" }}
          />
          <span
            className="text-[12px] font-medium"
            style={{ color: "#fb7185", fontFamily: "var(--font-mono)" }}
          >
            Last run had errors
          </span>
        </>
      ) : null}
    </div>
  );
}
