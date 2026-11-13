import { NextResponse } from "next/server";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";
import { listTerminals, startTerminal, TerminalError } from "@/lib/terminal";

export const dynamic = "force-dynamic";

/** Terminal sessions, optionally for one project. */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project");
  if (project === null) {
    return NextResponse.json({ ok: true, sessions: listTerminals() });
  }
  return NextResponse.json({ ok: true, sessions: listTerminals(project) });
}

/** Run a shell command in a project folder, streaming its output to subscribers. */
export async function POST(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "send JSON with a confirmation" },
      { status: 415 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as {
    project?: unknown;
    command?: unknown;
    confirm?: unknown;
    pty?: unknown;
    interactive?: unknown;
    cols?: unknown;
    rows?: unknown;
  };

  if (payload.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: "confirm the command before running it" },
      { status: 400 },
    );
  }

  const project = typeof payload.project === "string" ? payload.project : "";
  const command = typeof payload.command === "string" ? payload.command : "";
  const cols = typeof payload.cols === "number" ? payload.cols : undefined;
  const rows = typeof payload.rows === "number" ? payload.rows : undefined;
  const interactive = payload.interactive === true;

  if (!interactive && command.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "a command is required" },
      { status: 400 },
    );
  }

  try {
    const session = startTerminal({
      project,
      command,
      interactive,
      pty: payload.pty === true,
      cols,
      rows,
    });
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    if (error instanceof TerminalError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the session could not be started: ${message}` },
      { status: 500 },
    );
  }
}
