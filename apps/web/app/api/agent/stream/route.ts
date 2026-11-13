import { getAgentRun, subscribeAgentRun, type AgentEvent } from "@/lib/agent-session";

export const dynamic = "force-dynamic";

const KEEP_ALIVE_MS = 15_000;

function dataLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Server-sent events for one chat turn.
 *
 * The first event is a `snapshot` carrying every event recorded so far, so a browser that
 * connects halfway through still draws the whole turn; the live events follow. The stream ends
 * with `done` when the run does.
 */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("run") ?? "";
  const run = getAgentRun(runId);
  if (run === null) {
    return new Response("run not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(dataLine(event, data)));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        if (keepAlive !== null) clearInterval(keepAlive);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };

      const onEvent = (event: AgentEvent) => {
        const sent = send("event", event);
        if (event.type === "done" && sent) finish();
        if (!sent) finish();
      };

      // Reconnect case: the run may have finished between the page load and this request.
      const snapshot = getAgentRun(runId);
      if (snapshot === null) {
        finish();
        return;
      }
      send("snapshot", { run: { ...snapshot, events: undefined }, events: snapshot.events });
      if (snapshot.status !== "running") {
        send("done", { status: snapshot.status, error: snapshot.error });
        finish();
        return;
      }

      const un = subscribeAgentRun(runId, onEvent);
      if (un === null) {
        finish();
        return;
      }
      unsubscribe = un;

      // The run may have ended between the snapshot and the subscription.
      const after = getAgentRun(runId);
      if (after !== null && after.status !== "running") {
        send("done", { status: after.status, error: after.error });
        finish();
        return;
      }

      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          finish();
        }
      }, KEEP_ALIVE_MS);
      keepAlive.unref?.();

      request.signal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      // The client disconnected; subscriptions clean themselves up via the abort handler.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
