import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import {
  listProjects,
  openRouterKey,
  readConfig,
  type ChatTurn,
} from "@slate/shared";

import { runAgent } from "@/lib/agent";
import { readGoals } from "@/lib/goals";
import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import {
  decodeProjectSlug,
  projectFolder,
  projectsRoot,
} from "@/lib/projects";

export const dynamic = "force-dynamic";

const MAX_TURNS = 24;
const MAX_CHARS = 8000;

function cleanTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value.slice(-MAX_TURNS)) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { role?: unknown; content?: unknown };
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "system") continue;
    if (typeof row.content !== "string" || row.content.trim() === "") continue;
    turns.push({ role: row.role, content: row.content.slice(0, MAX_CHARS) });
  }
  return turns;
}

/** A compact snapshot of the workspace, so the agent knows what exists. */
function workspaceContext(project: string | null, root: string): string {
  const lines = [
    "You are Slate's project agent. You help the user plan, track and finish projects on this machine.",
    "",
    "You can change projects through the provided tools:",
    "- create_project: make a new project folder with a plan block and agent instructions.",
    "- update_plan: change the goal, status or milestone, and add a log line.",
    "- add_tasks: append tasks to Now, Next or Done; complete_task: move a task into Done.",
    "- add_goal and update_goal: manage the project's goals.json checklist.",
    "- list_projects and read_project: inspect anything before editing.",
    "",
    "Rules:",
    "- Use a tool for every change. Never say something changed unless the matching tool succeeded.",
    "- Never invent completed work. Only complete a task when the user says it is done.",
    "- Edit only the README plan block and goals.json, and only through these tools.",
    "- Keep plans small: Now at most 7 open tasks, Next at most 10. Prefer short, concrete lines.",
    "- If the project or the change is ambiguous, ask one short question before writing.",
    "- After a tool runs, summarize exactly what changed and where.",
    `- Today is ${new Date().toISOString().slice(0, 10)}.`,
  ];

  const list = listProjects(root, { git: false });
  if (list.length === 0) {
    lines.push("", "The projects root is empty.");
  } else {
    lines.push("", "Projects on this machine:");
    for (const entry of list) {
      const title = entry.title ?? entry.slug;
      const goal = entry.goal === null ? "no goal written" : entry.goal.replace(/\s+/g, " ");
      const status = entry.status ?? "no status";
      const milestone = entry.milestone === null ? "no milestone" : entry.milestone;
      const tasks = `${entry.tasks.done}/${entry.tasks.total} tasks done`;
      const id = entry.plan?.project === undefined ? "" : `; plan id ${entry.plan.project}`;
      lines.push(
        `- ${entry.slug}: ${title} — ${goal} (${status}; ${milestone}; ${tasks}${id})`,
      );
    }
  }

  if (project !== null) {
    const folder = projectFolder(decodeProjectSlug(project));
    const readmePath = folder === null ? null : join(folder, "README.md");
    if (folder !== null && readmePath !== null && existsSync(readmePath)) {
      const readme = readFileSync(readmePath, "utf8").slice(0, 12_000);
      lines.push(
        "",
        `The user is looking at the project "${project}". Its README follows.`,
        "",
        readme,
      );

      try {
        const goals = readGoals(folder);
        if (goals.length > 0) {
          lines.push("", "Its goals.json checklist:");
          for (const goal of goals) {
            lines.push(`- [${goal.status}] ${goal.id} — ${goal.title}`);
          }
        }
      } catch {
        lines.push("", "Its goals.json could not be read.");
      }
    }
  }

  return lines.join("\n");
}

export async function POST(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: "send JSON" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as {
    model?: unknown;
    messages?: unknown;
    prompt?: unknown;
    project?: unknown;
  };

  const messages = cleanTurns(payload.messages);
  if (messages.length === 0 && typeof payload.prompt === "string" && payload.prompt.trim() !== "") {
    messages.push({ role: "user", content: payload.prompt.trim().slice(0, MAX_CHARS) });
  }
  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: "a message is required" }, { status: 400 });
  }

  const config = readConfig();
  const model =
    typeof payload.model === "string" && payload.model.trim() !== ""
      ? payload.model.trim()
      : (config.openrouter.defaultModel ?? "");
  if (model === "") {
    return NextResponse.json(
      { ok: false, error: "choose a model in Settings first" },
      { status: 400 },
    );
  }

  const key = openRouterKey(config);
  if (key === null) {
    return NextResponse.json(
      { ok: false, error: "no OpenRouter key is set (open Settings)" },
      { status: 400 },
    );
  }

  const project = typeof payload.project === "string" && payload.project !== "" ? payload.project : null;
  const root = projectsRoot();

  const result = await runAgent({
    apiKey: key,
    model,
    system: workspaceContext(project, root),
    messages,
    context: { root, agent: "slate-agent" },
  });

  if (result.actions.length > 0) {
    revalidatePath("/", "layout");
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
