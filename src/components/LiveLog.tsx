"use client";

import { useRef, useEffect, useState } from "react";
import { useEventStream, type ScoutEvent } from "@/hooks/useEventStream";

const SOURCE_FILTERS = ["all", "scanner", "stock", "embed", "system"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

function eventColor(event: ScoutEvent): string {
  switch (event.type) {
    case "opportunity":
      return "#34d399";
    case "error":
      return "#fb7185";
    case "progress":
      return "#fbbf24";
    case "scan_start":
      return "#38bdf8";
    case "scan_end":
      return "#38bdf8";
    default:
      return "#c8d0e0";
  }
}

function eventPrefix(event: ScoutEvent): string {
  switch (event.type) {
    case "opportunity":
      return ">>> HIT";
    case "error":
      return "ERROR";
    case "progress":
      return "PROGRESS";
    case "scan_start":
      return "START";
    case "scan_end":
      return "DONE";
    default:
      return "LOG";
  }
}

function formatTime(ts: string): string {
  return ts.replace("T", " ").slice(11, 19);
}

export function LiveLog() {
  const { events, connected } = useEventStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<SourceFilter>("all");

  const filtered =
    filter === "all" ? events : events.filter((e) => e.source === filter);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // If user scrolled up more than 40px from bottom, pause auto-scroll
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: "#0a0e1a", borderColor: "#1e2d4a" }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "#1e2d4a", background: "#0d1220" }}
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: connected ? "#34d399" : "#fb7185",
              }}
            />
            {connected && (
              <div
                className="absolute w-1.5 h-1.5 rounded-full animate-ping"
                style={{ background: "#34d399", opacity: 0.4 }}
              />
            )}
          </div>
          <span
            className="text-[11px] font-medium uppercase tracking-wider"
            style={{ color: "#6880a8", fontFamily: "var(--font-mono)" }}
          >
            Live Output
          </span>
        </div>

        {/* Source filter tabs */}
        <div className="flex items-center gap-1">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider transition-colors"
              style={{
                color: filter === f ? "#34d399" : "#4a6080",
                background: filter === f ? "#34d39915" : "transparent",
                fontFamily: "var(--font-mono)",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto p-3 space-y-0.5"
        style={{ maxHeight: 400, minHeight: 120 }}
      >
        {filtered.length === 0 ? (
          <p
            className="text-center py-8"
            style={{
              color: "#4a6080",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            Waiting for activity...
          </p>
        ) : (
          filtered.map((event, i) => (
            <div
              key={`${event.timestamp}-${i}`}
              className="flex gap-2 leading-relaxed"
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            >
              <span style={{ color: "#4a6080", flexShrink: 0 }}>
                {formatTime(event.timestamp)}
              </span>
              <span
                className="font-medium"
                style={{ color: eventColor(event), flexShrink: 0, minWidth: 56 }}
              >
                {eventPrefix(event)}
              </span>
              <span style={{ color: "#5b7a9a", flexShrink: 0 }}>
                [{event.source}]
              </span>
              <span style={{ color: eventColor(event) }}>{event.message}</span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {!autoScroll && filtered.length > 0 && (
        <div
          className="text-center py-1 border-t cursor-pointer"
          style={{
            borderColor: "#1e2d4a",
            background: "#0d1220",
            color: "#4a6080",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
          onClick={() => {
            setAutoScroll(true);
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
        >
          Scroll paused — click to resume auto-scroll
        </div>
      )}
    </div>
  );
}
