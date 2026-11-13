import { NextResponse } from "next/server";

import { AgentRunError, stopAgentRun } from "@/lib/agent-session";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Stop the running turn for this chat.
 *
 * The run's process tree is killed, the run closes as cancelled, and the transcript keeps
 * everything the agent managed to do before the stop.
 */
export async function POST(request: Request) {
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
  const runId = typeof (body as { run?: unknown } | null)?.run === "string"
    ? ((body as { run: string }).run)
    : "";
  if (runId === "") {
    return NextResponse.json({ ok: false, error: "a run id is required" }, { status: 400 });
  }

  try {
    const run = stopAgentRun(runId);
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    if (error instanceof AgentRunError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
