import { NextResponse } from "next/server";

import { isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";
import { killTerminal, TerminalError } from "@/lib/terminal";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Stop a running session — the whole process tree, like the jobs runner. */
export async function POST(request: Request, context: Context) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }

  const { id } = await context.params;
  try {
    return NextResponse.json({ ok: true, session: killTerminal(id) });
  } catch (error) {
    if (error instanceof TerminalError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "the session could not be cancelled" },
      { status: 500 },
    );
  }
}
