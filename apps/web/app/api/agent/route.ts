import { NextResponse } from "next/server";

import { isJsonRequest, isLocalRequest } from "@/lib/local-request";
import {
  AgentRunError,
  agentFolder,
  clearStoredSessionId,
  contextLimitTokens,
  lastContextTokens,
  latestAgentRun,
  startAgentTurn,
  storedSessionId,
  type AgentFocus,
} from "@/lib/agent-session";
import { DEFAULT_CHAT_MODEL } from "@/lib/model-defaults";
import { decodeProjectSlug, projectsRoot } from "@/lib/projects";
import { capRemainingDollars, formatDollars, spentMicrosForModel } from "@/lib/spend";
import { guardWrite } from "@/lib/session";
import { capForModel, readConfig } from "@slate/shared";

export const dynamic = "force-dynamic";

/** The folder a chat request works in: the project's own, or the projects root for a workspace chat. */
function folderFor(project: string | null): string | null {
  return project === null ? projectsRoot() : agentFolder(project);
}

/**
 * Start one chat turn in a project.
 *
 * The turn runs through the local opencode CLI inside the project's own folder, so the agent
 * gets the full harness (read, write, edit, shell) plus Slate's plan and goal tools over MCP.
 */
export async function POST(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

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
    project?: unknown;
    prompt?: unknown;
    model?: unknown;
    focus?: unknown;
  };

  const rawProject =
    typeof payload.project === "string" && payload.project.trim() !== ""
      ? payload.project.trim()
      : null;
  const project = rawProject === null ? null : decodeProjectSlug(rawProject);
  const folder = folderFor(project);

  if (folder === null || folder === "") {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const model =
    typeof payload.model === "string" && payload.model.trim() !== ""
      ? payload.model.trim()
      : DEFAULT_CHAT_MODEL;
  const focus: AgentFocus = payload.focus === "goals" ? "goals" : "chat";

  const config = readConfig();
  const remaining = capRemainingDollars(config, model);
  if (remaining !== null && remaining <= 0) {
    const cap = capForModel(config, model) ?? 0;
    const spent = spentMicrosForModel(model);
    return NextResponse.json(
      {
        ok: false,
        error: `spend cap reached for ${model}: ${formatDollars(spent)} of ${formatDollars(
          Math.round(cap * 1_000_000),
        )} spent`,
      },
      { status: 402 },
    );
  }

  try {
    const run = startAgentTurn({ project, folder, prompt, model, focus });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    if (error instanceof AgentRunError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `the chat could not start: ${message}` },
      { status: 500 },
    );
  }
}

/** The newest run for a project, so a page reload can rejoin it, plus its session size. */
export async function GET(request: Request) {
  const projectParam = new URL(request.url).searchParams.get("project");
  const project =
    projectParam === null || projectParam === "" ? null : decodeProjectSlug(projectParam);
  const folder = folderFor(project);
  const run = latestAgentRun(project);
  return NextResponse.json({
    ok: true,
    run,
    session: {
      id: folder === null ? null : storedSessionId(folder),
      contextTokens: folder === null ? 0 : lastContextTokens(folder),
      limitTokens: contextLimitTokens(),
    },
  });
}

/** Start a fresh session for a project: the next turn no longer carries the old transcript. */
export async function DELETE(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: "local requests only" }, { status: 403 });
  }

  const projectParam = new URL(request.url).searchParams.get("project");
  const project =
    projectParam === null || projectParam === "" ? null : decodeProjectSlug(projectParam);
  const folder = folderFor(project);
  if (folder === null || folder === "") {
    return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  }

  if (latestAgentRun(project)?.status === "running") {
    return NextResponse.json(
      { ok: false, error: "the agent is working here; stop it first" },
      { status: 409 },
    );
  }

  clearStoredSessionId(folder);
  return NextResponse.json({ ok: true, session: { id: null, contextTokens: 0 } });
}
