import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import {
  appendPlanLog,
  completePlanTask,
  formatPlan,
  parsePlan,
  removePlanTask,
  upsertZone,
  type Plan,
  type PlanSection,
} from "@slate/shared";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import { decodeProjectSlug, projectFolder } from "@/lib/projects";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

interface LoadedPlan {
  path: string;
  text: string;
  plan: Plan;
}

function loadPlan(folder: string): LoadedPlan | null {
  const path = join(folder, "README.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const parsed = parsePlan(text);
  if (!parsed.ok) return null;
  return { path, text, plan: parsed.plan };
}

/** Write the plan back into the README's plan block. */
function writePlan(loaded: LoadedPlan, plan: Plan): void {
  const result = upsertZone(loaded.text, "plan", formatPlan(plan), {
    project: plan.project,
    version: "1",
  });
  if (result.changed) writeFileSync(loaded.path, result.text, "utf8");
}

/**
 * Edit the project's plan block: remove a task, or mark one done.
 *
 * The plan belongs to the agent, but a task the user does not want any more has to go somehow.
 */
export async function POST(request: Request, context: Context) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: "send JSON" }, { status: 415 });
  }

  const { slug: encoded } = await context.params;
  const slug = decodeProjectSlug(encoded);
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const payload = (body ?? {}) as {
    action?: unknown;
    section?: unknown;
    task?: unknown;
  };

  const action = payload.action === "complete" ? "complete" : "remove";
  const section = payload.section;
  if (section !== "now" && section !== "next" && section !== "done") {
    return NextResponse.json(
      { ok: false, error: "section must be now, next or done" },
      { status: 400 },
    );
  }

  const task = typeof payload.task === "string" ? payload.task.trim() : "";
  if (task === "") {
    return NextResponse.json({ ok: false, error: "a task is required" }, { status: 400 });
  }

  const loaded = loadPlan(folder);
  if (loaded === null) {
    return NextResponse.json(
      { ok: false, error: "this project has no readable plan block" },
      { status: 400 },
    );
  }

  if (action === "complete") {
    // Completing moves a task from Now or Next into Done.
    const result = completePlanTask(loaded.plan, task);
    if (result.task === null) {
      return NextResponse.json({ ok: false, error: "no task matched" }, { status: 404 });
    }
    if (result.from === "done") {
      return NextResponse.json({ ok: true, task: result.task, plan: loaded.plan });
    }
    const plan = appendPlanLog(result.plan, `completed: ${result.task.text}`);
    writePlan(loaded, plan);
    return NextResponse.json({ ok: true, task: result.task, plan });
  }

  const result = removePlanTask(loaded.plan, section, task);
  if (result.task === null) {
    return NextResponse.json({ ok: false, error: "no task matched" }, { status: 404 });
  }

  const plan = appendPlanLog(result.plan, `removed task: ${result.task.text}`);
  writePlan(loaded, plan);
  return NextResponse.json({ ok: true, task: result.task, plan });
}
