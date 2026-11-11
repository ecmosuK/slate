import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { decodeProjectSlug, projectFolder } from "@/lib/projects";

type GoalStatus = "pending" | "done";

interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

type Context = { params: Promise<{ slug: string }> };

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Read goals.json, tolerating the two shapes this app has written. */
function readGoals(path: string): Goal[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { goals?: unknown }).goals)
      ? (parsed as { goals: unknown[] }).goals
      : [];

  const goals: Goal[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string") continue;
    const status: GoalStatus = row.status === "done" ? "done" : "pending";
    goals.push({
      id: row.id,
      title: row.title,
      description: typeof row.description === "string" ? row.description : "",
      status,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    });
  }
  return goals;
}

function writeGoals(path: string, goals: Goal[]): void {
  const text = `${JSON.stringify({ goals }, null, 2)}\n`;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, "utf8");
  try {
    renameSync(temporary, path);
  } catch {
    // Some Windows filesystems refuse to replace an existing file with rename.
    writeFileSync(path, text, "utf8");
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is harmless.
    }
  }
}

async function resolve(context: Context): Promise<
  | { ok: true; folder: string; path: string }
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
  return { ok: true, folder, path: join(folder, "goals.json") };
}

export async function GET(_request: Request, context: Context) {
  const target = await resolve(context);
  if (!target.ok) return target.response;

  try {
    return NextResponse.json({ ok: true, goals: readGoals(target.path) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `goals.json could not be read: ${message}` },
      { status: 500 },
    );
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
  const title = clean(payload.title, 200);
  if (title === "") {
    return NextResponse.json({ ok: false, error: "a goal title is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const goal: Goal = {
    id: randomUUID(),
    title,
    description: clean(payload.description, 2000),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  try {
    const goals = readGoals(target.path);
    goals.push(goal);
    writeGoals(target.path, goals);
    return NextResponse.json({ ok: true, goal, goals });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the goal could not be saved: ${message}` },
      { status: 500 },
    );
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
    title?: unknown;
    description?: unknown;
    status?: unknown;
  };
  const id = clean(payload.id, 100);
  if (id === "") {
    return NextResponse.json({ ok: false, error: "a goal id is required" }, { status: 400 });
  }

  try {
    const goals = readGoals(target.path);
    const index = goals.findIndex((goal) => goal.id === id);
    if (index === -1) {
      return NextResponse.json({ ok: false, error: "goal not found" }, { status: 404 });
    }

    const current = goals[index] as Goal;
    const title = payload.title === undefined ? current.title : clean(payload.title, 200);
    if (title === "") {
      return NextResponse.json({ ok: false, error: "a goal title is required" }, { status: 400 });
    }
    const status: GoalStatus =
      payload.status === undefined
        ? current.status
        : payload.status === "done"
          ? "done"
          : "pending";

    goals[index] = {
      ...current,
      title,
      description:
        payload.description === undefined
          ? current.description
          : clean(payload.description, 2000),
      status,
      updatedAt: new Date().toISOString(),
    };
    writeGoals(target.path, goals);
    return NextResponse.json({ ok: true, goal: goals[index], goals });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the goal could not be updated: ${message}` },
      { status: 500 },
    );
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
    const goals = readGoals(target.path);
    const remaining = goals.filter((goal) => goal.id !== id);
    if (remaining.length === goals.length) {
      return NextResponse.json({ ok: false, error: "goal not found" }, { status: 404 });
    }
    writeGoals(target.path, remaining);
    return NextResponse.json({ ok: true, goals: remaining });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the goal could not be removed: ${message}` },
      { status: 500 },
    );
  }
}
