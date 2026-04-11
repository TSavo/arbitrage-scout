"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { LiveLog } from "@/components/LiveLog";

type ActionName = "scan" | "stock" | "trends" | "arbitrage" | "platforms";

interface ActionConfig {
  name: ActionName;
  label: string;
  runningLabel: string;
  description: string;
  async: boolean;
}

const ACTIONS: ActionConfig[] = [
  {
    name: "scan",
    label: "Run Scan",
    runningLabel: "Scanning...",
    description: "Scrape all configured marketplaces for new listings",
    async: true,
  },
  {
    name: "stock",
    label: "Load Stock",
    runningLabel: "Loading...",
    description: "Import PriceCharting CSV data for price lookups",
    async: true,
  },
  {
    name: "trends",
    label: "Analyze Trends",
    runningLabel: "Analyzing...",
    description: "Detect price risers and fallers across tracked items",
    async: false,
  },
  {
    name: "arbitrage",
    label: "Find Arbitrage",
    runningLabel: "Searching...",
    description: "Cross-marketplace deal finder for buy-low-sell-high opps",
    async: false,
  },
  {
    name: "platforms",
    label: "Refresh Platforms",
    runningLabel: "Refreshing...",
    description: "Rebuild cached platform stats and listing counts",
    async: false,
  },
];

interface ActionState {
  running: boolean;
  lastRun: string | null;
  result: string | null;
  error: string | null;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function summarizeResult(action: ActionName, data: Record<string, unknown>): string {
  if (!data) return "done";
  if (action === "trends") {
    const risers = Array.isArray(data.risers) ? data.risers.length : 0;
    const fallers = Array.isArray(data.fallers) ? data.fallers.length : 0;
    return `${risers} risers, ${fallers} fallers`;
  }
  if (action === "arbitrage") {
    const deals = Array.isArray(data.deals) ? data.deals.length : 0;
    return `${deals} deals found`;
  }
  if (action === "platforms") {
    const count = Array.isArray(data.platforms) ? data.platforms.length : 0;
    return `${count} platforms refreshed`;
  }
  if (action === "scan") {
    return data.status === "started" ? "scan started" : "scan complete";
  }
  if (action === "stock") {
    return data.status === "started" ? "stock loading" : "stock loaded";
  }
  return "done";
}

export function CommandCenter() {
  const router = useRouter();
  const [states, setStates] = useState<Record<ActionName, ActionState>>(() => {
    const init: Record<string, ActionState> = {};
    for (const a of ACTIONS) {
      init[a.name] = { running: false, lastRun: null, result: null, error: null };
    }
    return init as Record<ActionName, ActionState>;
  });

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasAsyncRunning = states.scan.running || states.stock.running;

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/actions/status");
      if (!res.ok) return;
      const data = await res.json();

      setStates((prev) => {
        const next = { ...prev };
        for (const key of ["scan", "stock"] as const) {
          const wasRunning = prev[key].running;
          const isRunning = data.running?.[key] ?? false;

          if (wasRunning && !isRunning) {
            // just finished
            const last = data.lastRun?.[key];
            next[key] = {
              running: false,
              lastRun: last?.at ?? new Date().toISOString(),
              result: last?.result ? summarizeResult(key, last.result) : "done",
              error: last?.error ?? null,
            };
          } else if (isRunning) {
            next[key] = { ...prev[key], running: true };
          }
        }
        return next;
      });
    } catch {
      // network hiccup, keep polling
    }
  }, []);

  // Start/stop polling based on whether async actions are running
  useEffect(() => {
    if (hasAsyncRunning) {
      pollingRef.current = setInterval(pollStatus, 3000);
      return () => {
        if (pollingRef.current) clearInterval(pollingRef.current);
      };
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
  }, [hasAsyncRunning, pollStatus]);

  // Refresh the page data when an async action finishes
  const prevRunningRef = useRef(hasAsyncRunning);
  useEffect(() => {
    if (prevRunningRef.current && !hasAsyncRunning) {
      router.refresh();
    }
    prevRunningRef.current = hasAsyncRunning;
  }, [hasAsyncRunning, router]);

  // On mount, fetch initial status
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/actions/status");
        if (!res.ok) return;
        const data = await res.json();
        setStates((prev) => {
          const next = { ...prev };
          for (const key of ["scan", "stock"] as const) {
            const isRunning = data.running?.[key] ?? false;
            const last = data.lastRun?.[key];
            next[key] = {
              running: isRunning,
              lastRun: last?.at ?? null,
              result: last?.result ? summarizeResult(key, last.result) : null,
              error: last?.error ?? null,
            };
          }
          return next;
        });
      } catch {
        // ignore
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function triggerAction(config: ActionConfig) {
    const { name } = config;

    setStates((prev) => ({
      ...prev,
      [name]: { ...prev[name], running: true, error: null, result: null },
    }));

    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      const data = await res.json();

      if (config.async) {
        // polling will handle completion
        // but mark running in case status endpoint hasn't caught up
        setStates((prev) => ({
          ...prev,
          [name]: { ...prev[name], running: true },
        }));
      } else {
        // sync action — result is in the response
        setStates((prev) => ({
          ...prev,
          [name]: {
            running: false,
            lastRun: new Date().toISOString(),
            result: summarizeResult(name, data),
            error: null,
          },
        }));
        router.refresh();
      }
    } catch (err) {
      setStates((prev) => ({
        ...prev,
        [name]: {
          running: false,
          lastRun: prev[name].lastRun,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  return (
    <div className="space-y-4">
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {ACTIONS.map((config) => {
        const state = states[config.name];
        return (
          <Card key={config.name} size="sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  {config.label}
                  {state.running && (
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                    </span>
                  )}
                </CardTitle>
                {config.async && (
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                    async
                  </Badge>
                )}
              </div>
              <CardDescription>{config.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                className={
                  state.running
                    ? undefined
                    : "bg-emerald-600 text-white hover:bg-emerald-500 border-emerald-700"
                }
                variant={state.running ? "secondary" : "default"}
                size="sm"
                disabled={state.running}
                onClick={() => triggerAction(config)}
              >
                {state.running ? config.runningLabel : config.label}
              </Button>

              {state.result && !state.running && (
                <p
                  className="text-xs text-emerald-400"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {state.result}
                </p>
              )}

              {state.error && !state.running && (
                <p
                  className="text-xs text-rose-400"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Error: {state.error}
                </p>
              )}
            </CardContent>
            {state.lastRun && (
              <CardFooter>
                <span
                  className="text-[11px] text-muted-foreground"
                  style={{ fontFamily: "var(--font-mono)" }}
                  suppressHydrationWarning
                >
                  Last run: {formatTimestamp(state.lastRun)}
                </span>
              </CardFooter>
            )}
          </Card>
        );
      })}
    </div>

    {/* Live log panel */}
    <LiveLog />
    </div>
  );
}
