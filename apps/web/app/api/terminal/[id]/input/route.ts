import { NextResponse } from "next/server";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";
import { writeTerminal, TerminalError } from "@/lib/terminal";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const MAX_INPUT_CHARS = 16_000;

/** Write to the session's stdin. Text only; raw control bytes are fine inside JSON escapes. */
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

  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.length === 0) {
    return NextResponse.json(
      { ok: false, error: "text is required" },
      { status: 400 },
    );
  }
  if (text.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { ok: false, error: `text is too long (${MAX_INPUT_CHARS} characters max)` },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  try {
    writeTerminal(id, text);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    if (error instanceof TerminalError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "input could not be delivered" },
      { status: 500 },
    );
  }
}
