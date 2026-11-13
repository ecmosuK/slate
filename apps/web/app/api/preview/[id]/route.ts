import { NextResponse } from "next/server";

import { stopPreview, getPreview, PreviewError } from "@/lib/preview";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One preview server, with the folder it serves. */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const preview = getPreview(id);
  if (preview === null) {
    return NextResponse.json({ ok: false, error: "preview not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, preview });
}

/** Stop a preview server Slate started for a project. */
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
    const preview = await stopPreview(id);
    return NextResponse.json({ ok: true, preview });
  } catch (error) {
    if (error instanceof PreviewError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the preview could not be stopped: ${message}` },
      { status: 500 },
    );
  }
}
