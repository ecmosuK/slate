import { NextResponse } from "next/server";

import { ScaffoldError, readProject, scaffoldProject } from "@slate/shared";

import { projectsRoot } from "../../../lib/projects";

export const dynamic = "force-dynamic";

/** Create a project folder: README with the three zones, agent instructions, pointer files. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { name?: unknown; description?: unknown; git?: unknown };
  const name = typeof payload.name === "string" ? payload.name : "";
  const description =
    typeof payload.description === "string" ? payload.description.slice(0, 500) : "";
  const git = payload.git === true;

  try {
    const result = scaffoldProject(projectsRoot(), { name, description, git });
    const project = readProject(result.folder, result.slug);
    return NextResponse.json({ ok: true, slug: result.slug, created: result.created, project });
  } catch (error) {
    const message =
      error instanceof ScaffoldError ? error.message : "the project could not be created";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
