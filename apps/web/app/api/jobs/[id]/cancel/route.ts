import { NextResponse } from "next/server";

import { JobError, cancelJob } from "@/lib/jobs";
import { isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Stop a running opencode task and its child processes. */
export async function POST(request: Request, context: Context) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }

  const { id } = await context.params;
  try {
    return NextResponse.json({ ok: true, job: cancelJob(id) });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { ok: false, error: "the task could not be cancelled" },
      { status: 500 },
    );
  }
}
