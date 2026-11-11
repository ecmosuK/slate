import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const job = getJob(id);
  if (job === null) {
    return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job });
}
