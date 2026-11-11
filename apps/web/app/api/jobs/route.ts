import { NextResponse } from "next/server";

import { JobError, listJobs, startJob, type JobMode } from "@/lib/jobs";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";

export const dynamic = "force-dynamic";

/** Recent tasks, newest first. */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project") ?? undefined;
  return NextResponse.json({ ok: true, jobs: listJobs(project) });
}

/** Start a task through the local opencode CLI. */
export async function POST(request: Request) {
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
    task?: unknown;
    mode?: unknown;
    model?: unknown;
    confirm?: unknown;
  };

  if (payload.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: "confirm the task before starting opencode" },
      { status: 400 },
    );
  }

  const project = typeof payload.project === "string" ? payload.project : "";
  const task = typeof payload.task === "string" ? payload.task : "";
  const mode: JobMode = payload.mode === "plan" ? "plan" : "build";
  const model = typeof payload.model === "string" ? payload.model : null;

  try {
    const job = startJob({ project, task, mode, model });
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the task could not be started: ${message}` },
      { status: 500 },
    );
  }
}
