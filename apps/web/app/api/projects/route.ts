import { existsSync, rmSync } from "node:fs";
import { NextResponse } from "next/server";

import { ScaffoldError, readProject, scaffoldProject } from "@slate/shared";

import { decodeProjectSlug, projectFolder, projectsRoot } from "../../../lib/projects";
import { isJsonRequest, isLocalRequest } from "../../../lib/local-request";
import { guardWrite } from "../../../lib/session";

export const dynamic = "force-dynamic";

/** Create a project folder: README with the three zones, agent instructions, pointer files. */
export async function POST(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

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

/** Delete a project folder from the projects root. */
export async function DELETE(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: "send JSON with a confirmation" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { slug?: unknown; confirm?: unknown };
  const rawSlug = typeof payload.slug === "string" ? payload.slug : "";
  if (rawSlug === "") {
    return NextResponse.json({ ok: false, error: "a project slug is required" }, { status: 400 });
  }
  if (payload.confirm !== true) {
    return NextResponse.json({ ok: false, error: "confirm deletion before removing a project" }, { status: 400 });
  }

  const slug = decodeProjectSlug(rawSlug);
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  try {
    rmSync(folder, { recursive: true, force: true });
    return NextResponse.json({ ok: true, slug });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: `could not delete project: ${message}` }, { status: 500 });
  }
}
