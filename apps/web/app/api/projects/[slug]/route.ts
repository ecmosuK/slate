import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { readProject } from "@slate/shared";

import { decodeProjectSlug, projectFolder } from "@/lib/projects";
import { projectSignature } from "@/lib/project-signature";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

/**
 * The project's current plan and goals, for the page to poll.
 *
 * The page renders this server-side too; polling it lets the page notice that the plan agent,
 * the task runner or the terminal changed the project without a manual reload.
 */
export async function GET(_request: Request, context: Context) {
  const { slug: encoded } = await context.params;
  const slug = decodeProjectSlug(encoded);
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  const project = readProject(folder, slug);
  return NextResponse.json({
    ok: true,
    signature: projectSignature(folder),
    plan: project.plan,
    taskItems: project.taskItems,
    nextSteps: project.nextSteps,
    warnings: project.warnings,
    goal: project.goal,
    status: project.status,
    milestone: project.milestone,
    updatedAt: project.updatedAt,
    tasks: project.tasks,
  });
}
