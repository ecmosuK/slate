import { NextResponse } from "next/server";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";
import { resizeTerminal, TerminalError } from "@/lib/terminal";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Tell a pseudo-terminal session that the window changed size.
 *
 * The terminal pane posts the size of its canvas when it is resized, so full-screen programs
 * redraw at the right shape.
 */
export async function POST(request: Request, context: Context) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: "send JSON" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { cols?: unknown; rows?: unknown };
  const cols = typeof payload.cols === "number" ? payload.cols : 0;
  const rows = typeof payload.rows === "number" ? payload.rows : 0;
  if (cols <= 0 || rows <= 0) {
    return NextResponse.json(
      { ok: false, error: "cols and rows are required" },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  try {
    return NextResponse.json({ ok: true, session: resizeTerminal(id, cols, rows) });
  } catch (error) {
    if (error instanceof TerminalError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the session could not be resized: ${message}` },
      { status: 500 },
    );
  }
}
