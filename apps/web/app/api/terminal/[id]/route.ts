import { NextResponse } from "next/server";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";
import { getTerminal, removeTerminal, TerminalError } from "@/lib/terminal";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One session, with its buffered output. */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const session = getTerminal(id);
  if (session === null) {
    return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, session });
}

/** Remove a finished session from the history. Running sessions must be cancelled first. */
export async function DELETE(request: Request, context: Context) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: "send JSON" }, { status: 415 });
  }

  const { id } = await context.params;
  try {
    removeTerminal(id);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    if (error instanceof TerminalError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "the session could not be removed" },
      { status: 500 },
    );
  }
}
