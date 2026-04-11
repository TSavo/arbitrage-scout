"use client";

import { useEffect, useState, useCallback, useRef } from "react";

export type ScoutEvent = {
  type: "log" | "progress" | "opportunity" | "scan_start" | "scan_end" | "error";
  source: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
};

export function useEventStream() {
  const [events, setEvents] = useState<ScoutEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
    }

    const source = new EventSource("/api/events");
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      setLastError(null);
    };

    source.onmessage = (e) => {
      try {
        const event: ScoutEvent = JSON.parse(e.data);
        setEvents((prev) => [...prev.slice(-200), event]);
      } catch {
        // Ignore malformed events
      }
    };

    source.onerror = () => {
      setConnected(false);
      setLastError("Connection lost");
      source.close();
      sourceRef.current = null;
      // Reconnect after 3s
      setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, connected, lastError, clearEvents };
}
