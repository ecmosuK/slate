/**
 * The preview runner, pinned to a project folder.
 *
 * The built-in static server lives in the bridge; this module decides *which* folder it should
 * serve and keeps the guardrails the terminal runner uses: inside the projects root only, and only
 * after `guardWrite` in the route layer has checked the machine is unlocked.
 */

import { existsSync } from "node:fs";
import { sep } from "node:path";

import {
  getPreview as getBridgePreview,
  hasStaticEntry as hasBridgeStaticEntry,
  listPreviews as listBridgePreviews,
  reconcilePreviews as reconcileBridgePreviews,
  resolveRunTargets,
  startPreview as startBridgePreview,
  staticEntryFolder as bridgeStaticEntryFolder,
  stopPreview as stopBridgePreview,
  type PreviewError as BridgePreviewError,
  type PreviewStatus,
  type PreviewSummary,
  type RunTarget,
} from "@slate/bridge";

import { startTerminal } from "@/lib/terminal";

import { projectFolder, projectsRoot } from "./projects";

export class PreviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PreviewError";
    this.status = status;
  }
}

function asPreviewError(error: unknown): PreviewError {
  if (error instanceof PreviewError) return error;
  const withStatus = error as { message?: unknown; status?: unknown };
  const message = typeof withStatus?.message === "string" ? withStatus.message : String(error);
  const status = typeof withStatus?.status === "number" ? withStatus.status : 500;
  return new PreviewError(message, status);
}

function requireProjectFolder(slug: string): string {
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    throw new PreviewError("project not found", 404);
  }
  const root = projectsRoot();
  if (folder !== root && !folder.startsWith(`${root}${sep}`)) {
    // Defence in depth; projectFolder already refuses climbs outside the root.
    throw new PreviewError("project outside the allowed root", 403);
  }
  return folder;
}

export interface StartPreviewInput {
  project: string;
  /** Pin the port; the operating system picks one when omitted. */
  port?: number;
}

export interface RunTargetOutcome {
  /** `session` starts a terminal command; `static` serves a folder with the built-in server. */
  mode: "static" | "session";
  /** The command to run, or empty for the built-in static server. */
  command: string;
  /** A short human phrase, e.g. "Vite dev server" or "Built-in static server". */
  label: string;
  /** A port worth preferring, or null when the process picks one. */
  portHint: number | null;
  /** The terminal session to watch, when a command was started. */
  sessionId: string | null;
  /** The static server to stop, when the built-in server was started. */
  serverId: string | null;
  /** The run target that produced this outcome, when one was resolved. */
  target: RunTarget | null;
}

export async function startPreview(input: StartPreviewInput): Promise<PreviewSummary> {
  const folder = requireProjectFolder(input.project);
  try {
    const hasEntry = hasBridgeStaticEntry(folder);
    const entryFolder = hasEntry ? bridgeStaticEntryFolder(folder) : null;
    if (entryFolder === null) {
      throw new PreviewError("the project has no static files to preview yet", 400);
    }
    return await startBridgePreview({
      folder: entryFolder,
      project: input.project,
      port: input.port,
      spaFallback: true,
      allowlistRoot: projectsRoot(),
    });
  } catch (error) {
    throw asPreviewError(error);
  }
}

export function listPreviews(project?: string): PreviewSummary[] {
  if (project !== undefined) {
    const folder = projectFolder(project);
    if (folder === null || !existsSync(folder)) return [];
  }
  try {
    return listBridgePreviews(project);
  } catch (error) {
    throw asPreviewError(error);
  }
}

export function getPreview(id: string): PreviewSummary | null {
  try {
    return getBridgePreview(id);
  } catch (error) {
    throw asPreviewError(error);
  }
}

export async function stopPreview(id: string): Promise<PreviewSummary> {
  try {
    return await stopBridgePreview(id);
  } catch (error) {
    throw asPreviewError(error);
  }
}

export function reconcilePreviews(): void {
  try {
    reconcileBridgePreviews();
  } catch {
    // Reconciliation is best effort; the next read stays honest anyway.
  }
}

/**
 * Start the thing the preview shows: either a terminal command (npm run dev, flask, uvicorn, a
 * bare python app) or the built-in static server, for a project. The preview then watches the
 * terminal session's output and points the frame at the port it announces.
 */
export async function runProjectCommand(input: {
  project: string;
  /** Override the resolved command, e.g. `npm run dev -- --port 4000`. */
  command?: string;
  /** Pin the port for the built-in static server; the OS picks one when omitted. */
  port?: number;
}): Promise<RunTargetOutcome> {
  const folder = requireProjectFolder(input.project);
  const override = input.command?.trim() ?? "";

  if (override !== "") {
    const session = await startTerminalCommand(input.project, override);
    return {
      mode: "session",
      command: override,
      label: override,
      portHint: null,
      sessionId: session.id,
      serverId: null,
      target: null,
    };
  }

  const targets = resolveRunTargets(folder);
  const target = targets[0] ?? null;
  if (target === null) {
    throw new PreviewError("no run target found for this project yet", 400);
  }

  if (target.kind === "static" && target.folder !== null) {
    const preview = await startBridgePreview({
      folder: target.folder,
      project: input.project,
      // Reuse the same port when the preview was stopped, so the URL stays stable across minimize.
      port: input.port ?? 0,
      spaFallback: true,
      allowlistRoot: projectsRoot(),
    });
    return {
      mode: "static",
      command: "",
      label: target.label,
      portHint: target.portHint,
      sessionId: null,
      serverId: preview.id,
      target,
    };
  }

  const session = await startTerminalCommand(input.project, target.command);
  return {
    mode: "session",
    command: target.command,
    label: target.label,
    portHint: target.portHint,
    sessionId: session.id,
    serverId: null,
    target,
  };
}

/** Start a single terminal command (the run the preview should watch). */
async function startTerminalCommand(project: string, command: string) {
  try {
    const session = startTerminal({ project, command, interactive: false, pty: true });
    return session;
  } catch (error) {
    throw asPreviewError(error);
  }
}

export type { BridgePreviewError, PreviewStatus, PreviewSummary, RunTarget };
