import { NextResponse } from "next/server";

import { runProjectCommand, listPreviews, type RunTargetOutcome, PreviewError } from "@/lib/preview";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Preview servers Slate has started for projects, optionally one project. */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project");
  const previews = listPreviews(project === null ? undefined : project);
  return NextResponse.json({ ok: true, previews });
}

/** Start the built-in static preview server for a project. */
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

  const payload = (body ?? {}) as { project?: unknown; port?: unknown; command?: unknown };
  const project = typeof payload.project === "string" ? payload.project : "";
  const port = typeof payload.port === "number" ? payload.port : undefined;

  if (project === "") {
    return NextResponse.json({ ok: false, error: "a project is required" }, { status: 400 });
  }

  try {
    const run: RunTargetOutcome = await runProjectCommand({
      project,
      command: typeof payload.command === "string" ? payload.command : undefined,
      port,
    });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    if (error instanceof PreviewError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the preview could not start: ${message}` },
      { status: 500 },
    );
  }
}
