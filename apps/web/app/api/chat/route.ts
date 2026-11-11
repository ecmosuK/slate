import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import {
  chat,
  openRouterKey,
  readConfig,
  type ChatTurn,
} from "@slate/shared";

import { decodeProjectSlug, projectFolder, projects } from "@/lib/projects";

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
function workspaceContext(project: string | null): string {
  const lines = ["You are Slate's project agent. You help the user plan, track and finish projects."];
  const list = projects();
  if (list.length === 0) {
    lines.push("The projects root is empty.");
  } else {
    lines.push("Projects on this machine:");
    for (const entry of list) {
      const title = entry.title ?? entry.slug;
      const goal = entry.goal === null ? "no goal written" : entry.goal.replace(/\s+/g, " ");
      const status = entry.status ?? "no status";
      const tasks = `${entry.tasks.done}/${entry.tasks.total} tasks done`;
      lines.push(`- ${entry.slug}: ${title} — ${goal} (${status}; ${tasks})`);
    }
  }

  if (project !== null) {
    const folder = projectFolder(decodeProjectSlug(project));
    const readmePath = folder === null ? null : join(folder, "README.md");
    if (readmePath !== null && existsSync(readmePath)) {
      const readme = readFileSync(readmePath, "utf8").slice(0, 12_000);
      lines.push(`\nThe user is looking at the project "${project}". Its README follows.\n`);
      lines.push(readme);
    }
  }

  lines.push(
    "\nAnswer in plain text, concisely. You can suggest README plan changes, but you cannot write files from this chat yet.",
  );
  return lines.join("\n");
}

export async function POST(request: Request) {
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
  const conversation: ChatTurn[] = [
    { role: "system", content: workspaceContext(project) },
    ...messages.filter((turn) => turn.role !== "system"),
  ];

  const result = await chat(key, model, conversation);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
