import { NextResponse } from "next/server";

import type { TerminalEvent } from "@/lib/terminal";
import { getTerminal, subscribeTerminal } from "@/lib/terminal";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const KEEP_ALIVE_MS = 15_000;

function dataLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Server-sent events stream for one session.
 *
 * The first event is a `snapshot` with the session's status; a `stdout`/`stderr` replay of the
 * buffered output follows, then the live stream. The connection closes when the process exits.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const session = getTerminal(id);
  if (session === null) {
    return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
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
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };

      const onEvent = (event: TerminalEvent) => {
        if (event.type === "stdout" || event.type === "stderr") {
          send(event.type, { text: event.text });
          return;
        }
        if (event.type === "error") {
          send("error", { message: event.message });
          return;
        }
        // exit: forward the event, then close the stream.
        send("exit", { code: event.code, signal: event.signal });
        finish();
      };

      send("snapshot", { status: session.status });
      try {
        // replay carries the buffered output (if any) as a stdout event before the handler
        // is registered live, so nothing written between reads is lost.
        const un = subscribeTerminal(id, onEvent, { replay: true });
        if (closed) {
          // The session had already finished; the replay ran synchronously and closed the stream.
          un();
          return;
        }
        unsubscribe = un;
      } catch {
        // The session vanished between reads; close out cleanly.
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
      // The client disconnected; no state to persist, subscriptions clean themselves up via
      // the abort handler above when the runtime aborts the request signal.
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
