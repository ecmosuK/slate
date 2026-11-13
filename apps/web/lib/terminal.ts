/**
 * The terminal runner, pinned to a project folder.
 *
 * The bridge spawns the process and streams stdout/stderr; this module decides *where* it may
 * run: inside the configured projects root only, and only after `guardWrite` in the route layer
 * has checked the machine is unlocked.
 */

import { existsSync } from "node:fs";

import {
  killTerminal as killBridge,
  startTerminal as startBridge,
  listTerminals as listBridge,
  getTerminal as getBridge,
  removeTerminal as removeBridge,
  resizeTerminal as resizeBridge,
  subscribeTerminal as subscribeBridge,
  writeTerminal as writeBridge,
  type TerminalDetail,
  type TerminalEvent,
  type TerminalSummary,
} from "@slate/bridge";

import { projectFolder, projectsRoot } from "./projects";

export class TerminalError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TerminalError";
    this.status = status;
  }
}

function asTerminalError(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  const withStatus = error as { message?: unknown; status?: unknown };
  const message =
    typeof withStatus?.message === "string" ? withStatus.message : String(error);
  const status = typeof withStatus?.status === "number" ? withStatus.status : 500;
  return new TerminalError(message, status);
}

function requireProjectFolder(slug: string): string {
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) {
    throw new TerminalError("project not found", 404);
  }
  return folder;
}

export interface StartTerminalInput {
  project: string;
  command: string;
  /** Run in a pseudo-terminal, so colours, cursor movement and Ctrl+C work. */
  pty?: boolean;
  /**
   * Start an interactive shell instead of running one command.
   *
   * The pane uses this: a shell that lives until it is stopped, with commands typed into it.
   */
  interactive?: boolean;
  /** Terminal size in columns, for a PTY session. */
  cols?: number;
  /** Terminal size in rows, for a PTY session. */
  rows?: number;
}

/** Run a command in a project folder. Arbitrary shell goes here, so it stays behind a confirm in the route. */
export function startTerminal(input: StartTerminalInput): TerminalSummary {
  const folder = requireProjectFolder(input.project);
  try {
    return startBridge({
      cwd: folder,
      command: input.command,
      allowlistRoot: projectsRoot(),
      project: input.project,
      pty: input.pty === true,
      interactive: input.interactive === true,
      cols: input.cols,
      rows: input.rows,
    });
  } catch (error) {
    throw asTerminalError(error);
  }
}

export function listTerminals(project?: string): TerminalSummary[] {
  // A folder that does not exist lists as empty, matching the jobs list behaviour.
  if (project !== undefined) {
    const folder = projectFolder(project);
    if (folder === null || !existsSync(folder)) return [];
  }
  return listBridge({ project });
}

export function getTerminal(id: string): TerminalDetail | null {
  return getBridge(id);
}

export function subscribeTerminal(
  id: string,
  handler: (event: TerminalEvent) => void,
  options: { replay?: boolean } = {},
): () => void {
  try {
    return subscribeBridge(id, handler, options);
  } catch (error) {
    throw asTerminalError(error);
  }
}

export function writeTerminal(id: string, text: string): void {
  try {
    writeBridge(id, text);
  } catch (error) {
    throw asTerminalError(error);
  }
}

/** Tell a pseudo-terminal session that the window changed size. */
export function resizeTerminal(id: string, cols: number, rows: number): TerminalSummary {
  try {
    return resizeBridge(id, cols, rows);
  } catch (error) {
    throw asTerminalError(error);
  }
}

export function killTerminal(id: string): TerminalSummary {
  try {
    return killBridge(id);
  } catch (error) {
    throw asTerminalError(error);
  }
}

export function removeTerminal(id: string): void {
  try {
    removeBridge(id);
  } catch (error) {
    throw asTerminalError(error);
  }
}

export type { TerminalDetail, TerminalEvent, TerminalSummary };
