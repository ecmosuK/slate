import { NextResponse } from "next/server";

import { projectFolder } from "@/lib/projects";
import { terminalDependencySetup } from "@/lib/terminal-dependencies";

export const dynamic = "force-dynamic";

/** Return the install step inferred from standard project manifests, if any. */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project") ?? "";
  const folder = projectFolder(project);
  if (folder === null) {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    setup: terminalDependencySetup(folder),
  });
}
