import { NextResponse } from "next/server";

import { capForModel, readConfig } from "@slate/shared";

import { JobError, listJobs, startJob, type JobMode } from "@/lib/jobs";
import { DEFAULT_JOB_MODEL } from "@/lib/job-defaults";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { capRemainingDollars, formatDollars, spentMicrosForModel } from "@/lib/spend";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Recent tasks, newest first. */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project") ?? undefined;
  return NextResponse.json({ ok: true, jobs: listJobs(project) });
}

/** Start a task through the local opencode CLI. */
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
  const modelId = model ?? DEFAULT_JOB_MODEL;

  const config = readConfig();
  const remaining = capRemainingDollars(config, modelId);
  if (remaining !== null && remaining <= 0) {
    const cap = capForModel(config, modelId) ?? 0;
    const spent = spentMicrosForModel(modelId) / 1_000_000;
    return NextResponse.json(
      {
        ok: false,
        error: `spend cap reached for ${modelId}: $${formatDollars(spent * 1_000_000)} of $${formatDollars(cap * 1_000_000)} spent`,
      },
      { status: 402 },
    );
  }

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
