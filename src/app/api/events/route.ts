export const dynamic = "force-dynamic";

import { eventBus, type ScoutEvent } from "@/lib/events";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "log", source: "system", message: "Connected to event stream", timestamp: new Date().toISOString() })}\n\n`,
        ),
      );

      const handler = (event: ScoutEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected — cleanup handled below
        }
      };

      eventBus.on("scout_event", handler);

      // Keepalive every 30s to prevent proxy/browser timeout
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);

      // Cleanup when the stream is cancelled (client disconnects)
      const cleanup = () => {
        eventBus.off("scout_event", handler);
        clearInterval(keepalive);
      };

      // The cancel callback fires when the client closes the connection
      // We store cleanup so cancel() can call it
      (controller as unknown as Record<string, unknown>).__cleanup = cleanup;
    },
    cancel(controller) {
      const cleanup = (controller as unknown as Record<string, unknown>).__cleanup as
        | (() => void)
        | undefined;
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
