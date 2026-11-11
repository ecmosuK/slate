import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { decodeProjectSlug, projectFolder } from "@/lib/projects";
import {
  GoalError,
  createGoal,
  deleteGoal,
  readGoals,
  updateGoal,
} from "@/lib/goals";

type Context = { params: Promise<{ slug: string }> };

async function resolve(
  context: Context,
): Promise<
  | { ok: true; folder: string }
  | { ok: false; response: NextResponse }
> {
  const { slug: encoded } = await context.params;
  const slug = decodeProjectSlug(encoded);
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "project not found" }, { status: 404 }),
    };
  }
  return { ok: true, folder };
}

function failure(error: unknown, action: string): NextResponse {
  if (error instanceof GoalError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json(
    { ok: false, error: `${action}: ${message}` },
    { status: 500 },
  );
}

export async function GET(_request: Request, context: Context) {
  const target = await resolve(context);
  if (!target.ok) return target.response;

  try {
    return NextResponse.json({ ok: true, goals: readGoals(target.folder) });
  } catch (error) {
    return failure(error, "goals.json could not be read");
  }
}

export async function POST(request: Request, context: Context) {
  const target = await resolve(context);
  if (!target.ok) return target.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { title?: unknown; description?: unknown };

  try {
    const goal = createGoal(target.folder, payload);
    return NextResponse.json({ ok: true, goal, goals: readGoals(target.folder) });
  } catch (error) {
    return failure(error, "the goal could not be saved");
  }
}

export async function PATCH(request: Request, context: Context) {
  const target = await resolve(context);
  if (!target.ok) return target.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as {
    id?: unknown;
    match?: unknown;
    title?: unknown;
    description?: unknown;
    status?: unknown;
  };

  try {
    const goal = updateGoal(target.folder, payload);
    return NextResponse.json({ ok: true, goal, goals: readGoals(target.folder) });
  } catch (error) {
    return failure(error, "the goal could not be updated");
  }
}

export async function DELETE(request: Request, context: Context) {
  const target = await resolve(context);
  if (!target.ok) return target.response;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (id === "") {
    return NextResponse.json({ ok: false, error: "a goal id is required" }, { status: 400 });
  }

  try {
    return NextResponse.json({ ok: true, goals: deleteGoal(target.folder, id) });
  } catch (error) {
    return failure(error, "the goal could not be removed");
  }
}
