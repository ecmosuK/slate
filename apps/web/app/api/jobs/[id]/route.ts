import { NextResponse } from "next/server";

import { deleteJob, getJob, JobError } from "@/lib/jobs";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One run, with its log. */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const job = getJob(id);
  if (job === null) {
    return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job });
}

/** Remove a finished run from the project history. */
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
    deleteJob(id);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the run could not be deleted: ${message}` },
      { status: 500 },
    );
  }
}
