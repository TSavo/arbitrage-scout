/**
 * In-memory event bus for real-time SSE streaming.
 * Module-level singleton — works within a single Next.js process.
 */

import { EventEmitter } from "events";

export type ScoutEvent = {
  type: "log" | "progress" | "opportunity" | "scan_start" | "scan_end" | "error";
  source: string; // "scanner", "embed", "stock", etc
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
};

class EventBus extends EventEmitter {
  emitScoutEvent(event: ScoutEvent): boolean {
    return this.emit("scout_event", event);
  }

  /** Convenience: create and emit in one call */
  push(
    type: ScoutEvent["type"],
    source: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    this.emitScoutEvent({
      type,
      source,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

// Bump the default listener limit — SSE clients each add a listener
const eventBus = new EventBus();
eventBus.setMaxListeners(100);

export { eventBus };
