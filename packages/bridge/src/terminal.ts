/**
 * Terminal runner bridge.
 *
 * Spawns shell processes with their working directory pinned to one project folder, and keeps
 * every byte of stdout/stderr in a bounded buffer so consumers (the terminal UI, an SSE stream,
 * a late subscriber) can replay what happened and then receive the rest live.
 *
 * State lives on `globalThis` so it survives Next.js dev-server reloads, like the jobs store.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { isInside, isRefusedPath } from "./safety.ts";
import { spawnPty, type PtyHandle } from "./pty.ts";

export type TerminalStatus = "running" | "exited" | "failed" | "cancelled";
export type TerminalStream = "stdout" | "stderr";

export type TerminalEvent =
  | { type: "stdout"; id: string; text: string }
  | { type: "stderr"; id: string; text: string }
  | { type: "exit"; id: string; code: number | null; signal: string | null }
  | { type: "error"; id: string; message: string };

export interface TerminalSummary {
  id: string;
  /** Optional pass-through label, e.g. the project slug, so callers can list per project. */
  project: string | null;
  command: string;
  cwd: string;
  status: TerminalStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export interface TerminalDetail extends TerminalSummary {
  /** Everything written to stdout and stderr, capped at MAX_OUTPUT_CHARS. */
  output: string;
}

export interface StartTerminalInput {
  /** Directory the process runs in. Must exist, must be a directory, must not be refused. */
  cwd: string;
  /** The command line to run. Executed through the shell unless `shell` is false. */
  command: string;
  /** Extra arguments, used when `shell` is false. */
  args?: string[];
  /** true (default) uses the platform default shell, a string picks one, false spawns directly. */
  shell?: boolean | string;
  /** When set, `cwd` must resolve inside this root, or the start is refused. */
  allowlistRoot?: string;
  /** Extra environment variables, merged over process.env. */
  env?: Record<string, string | undefined>;
  /** Optional label echoed back on the summary, e.g. the project slug. */
  project?: string | null;
  /**
   * Run in a pseudo-terminal instead of pipes.
   *
   * A PTY is what makes the session behave like a real console: the shell echoes input, colours
   * and cursor movement work, and Ctrl+C interrupts the foreground program. Pipes give plain
   * output only, so this is opt-in.
   */
  pty?: boolean;
  /**
   * Start an interactive shell instead of running one command.
   *
   * The session then lives until it is stopped, and commands are typed into it. This is what a
   * terminal pane wants: `npm run dev` and then `git status` in the same shell.
   */
  interactive?: boolean;
  /** Terminal size in columns, for a PTY session. */
  cols?: number;
  /** Terminal size in rows, for a PTY session. */
  rows?: number;
}

/**
 * The environment a terminal process gets.
 *
 * Pipes are not a terminal, so Python block-buffers stdout and a server can sit on its "Serving
 * HTTP on ... port 8099" line until it exits. Unbuffering it lets the port reach the preview while
 * the server is still running. A caller's own setting wins.
 */
function terminalEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1",
    ...(extra ?? {}),
  };
}

/** The platform's interactive shell, used for an interactive session. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === "win32") {
    const root = env.SystemRoot ?? "C:\\Windows";
    return {
      file: env.POWERSHELL_EXE ?? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ["-NoLogo", "-NoProfile", "-NoExit"],
    };
  }
  return { file: env.SHELL ?? "/bin/bash", args: [] };
}

export class TerminalError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TerminalError";
    this.status = status;
  }
}

const MAX_OUTPUT_CHARS = 200_000;
const MAX_TERMINALS = 24;
const MAX_COMMAND_CHARS = 8000;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 2000;

export type TerminalSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ("ignore" | "pipe")[];
    windowsHide: boolean;
    shell: boolean | string;
  },
) => ChildProcess;

let spawnImpl: TerminalSpawn = spawn as unknown as TerminalSpawn;

/** Replace the process spawner used for terminal sessions. Pass null to restore the real one. */
export function setTerminalSpawn(fn: TerminalSpawn | null): void {
  spawnImpl = fn ?? (spawn as unknown as TerminalSpawn);
}

/** How a run's process tree is stopped. Tests replace it. */
let killImpl: (child: ChildProcess | null) => void = killTree;

/** Replace the process-tree killer. Pass null to restore the real one. */
export function setTerminalKill(fn: ((child: ChildProcess | null) => void) | null): void {
  killImpl = fn ?? killTree;
}

interface TerminalRecord extends TerminalSummary {
  output: string;
  stopReason: "cancelled" | null;
}

interface TerminalEntry {
  record: TerminalRecord;
  child: ChildProcess | null;
  /** The pseudo-terminal, when the session runs in one. */
  pty: PtyHandle | null;
}

type Handler = (event: TerminalEvent) => void;

const store = globalThis as unknown as {
  __slateTerminals?: Map<string, TerminalEntry>;
  __slateTerminalListeners?: Map<string, Set<Handler>>;
};
const terminals = store.__slateTerminals ?? new Map<string, TerminalEntry>();
const listeners = store.__slateTerminalListeners ?? new Map<string, Set<Handler>>();
store.__slateTerminals = terminals;
store.__slateTerminalListeners = listeners;

function appendOutput(record: TerminalRecord, text: string): void {
  record.output += text;
  if (record.output.length > MAX_OUTPUT_CHARS) {
    record.output = `[earlier output truncated]\n${record.output.slice(-MAX_OUTPUT_CHARS)}`;
  }
}

function publicSummary(record: TerminalRecord): TerminalSummary {
  return {
    id: record.id,
    project: record.project,
    command: record.command,
    cwd: record.cwd,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
  };
}

function publicDetail(record: TerminalRecord): TerminalDetail {
  return { ...publicSummary(record), output: record.output };
}

function notify(event: TerminalEvent): void {
  const set = listeners.get(event.id);
  if (set === undefined) return;
  for (const handler of set) {
    try {
      handler(event);
    } catch {
      // A broken subscriber must not take the process down with it.
    }
  }
}

function prune(): void {
  if (terminals.size <= MAX_TERMINALS) return;
  const finished = [...terminals.values()].filter((entry) => entry.record.status !== "running");
  finished.sort((a, b) => a.record.endedAt?.localeCompare(b.record.endedAt ?? "") ?? 0);
  for (const entry of finished) {
    if (terminals.size <= MAX_TERMINALS) break;
    terminals.delete(entry.record.id);
  }
}

function killTree(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // The process may already be gone.
        }
      });
      return;
    } catch {
      // Fall through to child.kill().
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already be gone.
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }, 5000).unref();
}

function resolveWorkingDirectory(input: StartTerminalInput): string {
  const folder = resolve(input.cwd);
  if (!existsSync(folder)) throw new TerminalError("working directory not found", 404);
  try {
    if (!statSync(folder).isDirectory()) {
      throw new TerminalError("the working directory is a file, not a folder");
    }
  } catch (error) {
    if (error instanceof TerminalError) throw error;
    throw new TerminalError("the working directory could not be read", 400);
  }
  if (isRefusedPath(folder)) throw new TerminalError(`refused path: ${folder}`);
  if (input.allowlistRoot !== undefined && !isInside(input.allowlistRoot, folder)) {
    throw new TerminalError("working directory outside the allowed root", 403);
  }
  return folder;
}

function validateCommand(input: StartTerminalInput): { command: string; args: string[] } {
  const command = input.command.trim();
  if (command === "") throw new TerminalError("a command is required");
  if (command.length > MAX_COMMAND_CHARS) {
    throw new TerminalError(`the command is too long (${MAX_COMMAND_CHARS} characters max)`);
  }
  if (/\0/.test(command)) throw new TerminalError("the command contains a NUL byte");

  const args = input.args ?? [];
  if (input.shell === false) {
    if (args.length > MAX_ARGS) {
      throw new TerminalError(`too many arguments (${MAX_ARGS} max)`);
    }
    for (const arg of args) {
      if (typeof arg !== "string") throw new TerminalError("every argument must be a string");
      if (arg.length > MAX_ARG_CHARS) {
        throw new TerminalError(`an argument is too long (${MAX_ARG_CHARS} characters max)`);
      }
      if (/\0/.test(arg)) throw new TerminalError("an argument contains a NUL byte");
    }
  } else if (input.args !== undefined && input.args.length > 0) {
    // Shell mode builds the argv itself; a separate args array would silently do nothing.
    throw new TerminalError("pass a full command line, or set shell: false with explicit args");
  }
  return { command, args: [...args] };
}

/**
 * Spawn a shell process in a project folder and start streaming its output.
 * The session runs until the process exits or is killed; there is no default timeout, because
 * a dev server is meant to run until you stop it.
 */
export function startTerminal(input: StartTerminalInput): TerminalSummary {
  const folder = resolveWorkingDirectory(input);

  // An interactive session runs the platform's shell, so commands are typed into it.
  const interactive = input.interactive === true;
  const shell = interactive ? defaultShell() : null;
  const { command, args } =
    shell === null ? validateCommand(input) : { command: shell.file, args: shell.args };

  prune();
  if (terminals.size >= MAX_TERMINALS) {
    throw new TerminalError(`too many terminal sessions (${MAX_TERMINALS} max); stop or remove some first`, 429);
  }

  const now = new Date().toISOString();
  const record: TerminalRecord = {
    id: randomUUID(),
    project: input.project ?? null,
    command: interactive ? "shell" : command,
    cwd: folder,
    status: "running",
    createdAt: now,
    startedAt: now,
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    output: interactive ? "" : `$ ${command}\n`,
    stopReason: null,
  };
  const entry: TerminalEntry = { record, child: null, pty: null };
  terminals.set(record.id, entry);

  // A pseudo-terminal session, when one was asked for and one is available.
  if (input.pty === true) {
    try {
      const pty = spawnPty(command, args, {
        cwd: folder,
        env: terminalEnv(input.env),
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        ...(process.platform === "win32" ? { useConpty: false } : {}),
      });
      entry.pty = pty;

      pty.onData((text) => {
        appendOutput(record, text);
        notify({ type: "stdout", id: record.id, text });
      });

      pty.onExit((event) => {
        if (record.stopReason === "cancelled") {
          record.status = "cancelled";
        } else if (event.exitCode === 0) {
          record.status = "exited";
        } else {
          record.status = "failed";
          record.error = `the process exited with code ${event.exitCode}`;
        }
        record.exitCode = event.exitCode;
        record.endedAt = new Date().toISOString();
        entry.pty = null;
        appendOutput(
          record,
          `\n— exited${event.exitCode === 0 ? "" : ` (code ${event.exitCode})`}\n`,
        );
        notify({ type: "exit", id: record.id, code: event.exitCode, signal: null });
      });

      return publicSummary(record);
    } catch (error) {
      // Fall back to pipes rather than refusing to run: plain output still beats nothing.
      const message = error instanceof Error ? error.message : String(error);
      appendOutput(record, `— no pseudo-terminal (${message}); running with pipes instead\n`);
    }
  }

  // No queue: unlike the job runner, terminals run directly. Callers that want one command per
  // project should kill the previous session themselves.
  let child: ChildProcess;
  try {
    child = spawnImpl(command, args, {
      cwd: folder,
      env: terminalEnv(input.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // An interactive shell is already a complete executable path. Don't wrap it in cmd.exe or
      // /bin/sh; that breaks terminal semantics (and makes PowerShell input behave like a command).
      shell: interactive ? false : (input.shell ?? true),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.status = "failed";
    record.endedAt = new Date().toISOString();
    record.error = message;
    appendOutput(record, `could not start the process: ${message}\n`);
    notify({ type: "error", id: record.id, message });
    return publicSummary(record);
  }

  entry.child = child;

  const pipeStream = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendOutput(record, text);
    notify({ type: stream, id: record.id, text });
  };
  child.stdout?.on("data", pipeStream("stdout"));
  child.stderr?.on("data", pipeStream("stderr"));

  child.on("error", (error) => {
    record.status = "failed";
    record.error = error.message;
    record.endedAt = new Date().toISOString();
    appendOutput(record, `the process errored: ${error.message}\n`);
    notify({ type: "error", id: record.id, message: error.message });
  });

  child.on("close", (code, signal) => {
    if (record.stopReason === "cancelled") {
      record.status = "cancelled";
    } else if (code === 0 || code === null) {
      record.status = "exited";
    } else {
      record.status = "failed";
      record.error = `the process exited with code ${code}`;
    }
    record.exitCode = code;
    record.signal = signal;
    record.endedAt = new Date().toISOString();
    entry.child = null;
    appendOutput(record, `\n— exited${code === null ? "" : ` (code ${code})`}${signal === null ? "" : `, signal ${signal}`}\n`);
    notify({ type: "exit", id: record.id, code, signal });
  });

  return publicSummary(record);
}

/** Sessions matching the filter. Running and finished alike; list order is newest first. */
export function listTerminals(options: { project?: string } = {}): TerminalSummary[] {
  reconcileTerminals();
  const wanted = options.project;
  return [...terminals.values()]
    .map((entry) => publicSummary(entry.record))
    .filter((summary) => wanted === undefined || summary.project === wanted)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getTerminal(id: string): TerminalDetail | null {
  const entry = terminals.get(id);
  return entry === undefined ? null : publicDetail(entry.record);
}

/**
 * Attach a handler to live events for one session. Returns an unsubscribe function.
 * With `replay: true`, the handler first receives the buffered output as a single `stdout`
 * event (and, for a finished session, an `exit` event), so a late subscriber misses nothing.
 */
export function subscribeTerminal(
  id: string,
  handler: Handler,
  options: { replay?: boolean } = {},
): () => void {
  const entry = terminals.get(id);
  if (entry === undefined) throw new TerminalError("session not found", 404);
  let set = listeners.get(id);
  if (set === undefined) {
    set = new Set();
    listeners.set(id, set);
  }

  if (options.replay === true) {
    try {
      if (entry.record.output.length > 0) {
        handler({ type: "stdout", id, text: entry.record.output });
      }
      if (entry.record.status !== "running") {
        handler({
          type: "exit",
          id,
          code: entry.record.exitCode,
          signal: entry.record.signal,
        });
      }
    } catch {
      // A broken handler must not wedge the subscription.
    }
  }

  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) listeners.delete(id);
  };
}

/** Write raw bytes to the process's stdin. Throws when the session is not running. */
export function writeTerminal(id: string, data: string): void {
  const entry = terminals.get(id);
  if (entry === undefined) throw new TerminalError("session not found", 404);
  if (entry.record.status !== "running") {
    throw new TerminalError("the session is not running", 409);
  }

  if (entry.pty !== null) {
    try {
      entry.pty.write(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(`input could not be written: ${message}`, 500);
    }
    return;
  }

  if (entry.child === null) {
    throw new TerminalError("the session is not running", 409);
  }
  const stdin = entry.child.stdin;
  if (stdin === null || stdin.destroyed) {
    throw new TerminalError("the session does not accept input", 409);
  }
  try {
    stdin.write(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerminalError(`input could not be written: ${message}`, 500);
  }
}

/**
 * Tell a pseudo-terminal session that the window changed size.
 *
 * A pipe session has no size, so this is only meaningful for a PTY one.
 */
export function resizeTerminal(id: string, cols: number, rows: number): TerminalSummary {
  const entry = terminals.get(id);
  if (entry === undefined) throw new TerminalError("session not found", 404);
  if (entry.record.status !== "running") return publicSummary(entry.record);
  if (entry.pty === null) return publicSummary(entry.record);

  const width = Math.max(1, Math.min(500, Math.trunc(cols)));
  const height = Math.max(1, Math.min(200, Math.trunc(rows)));
  try {
    entry.pty.resize(width, height);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TerminalError(`the session could not be resized: ${message}`, 500);
  }
  return publicSummary(entry.record);
}

/** Stop a running session; the whole process tree is killed. Queued output is flushed first. */
export function killTerminal(id: string): TerminalSummary {
  const entry = terminals.get(id);
  if (entry === undefined) throw new TerminalError("session not found", 404);
  if (entry.record.status !== "running") return publicSummary(entry.record);

  entry.record.stopReason = "cancelled";
  appendOutput(entry.record, "\n— cancellation requested\n");

  if (entry.pty !== null) {
    try {
      entry.pty.kill();
    } catch {
      // The session may already be gone.
    }
    entry.pty = null;
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    appendOutput(entry.record, "— stopped\n");
    notify({ type: "exit", id: entry.record.id, code: null, signal: null });
    return publicSummary(entry.record);
  }

  if (entry.child === null) {
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    appendOutput(entry.record, "— no process was running\n");
    return publicSummary(entry.record);
  }

  killImpl(entry.child);

  // Safety net: if the process refuses to die, the session must not stay "running" forever.
  const safety = setTimeout(() => {
    if (entry.record.status !== "running") return;
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    entry.child = null;
    appendOutput(entry.record, "— the process did not stop in time; the session was closed\n");
    notify({ type: "exit", id: entry.record.id, code: null, signal: null });
  }, 5000);
  safety.unref();

  return publicSummary(entry.record);
}

/** Remove a finished session from history. Running sessions must be stopped first. */
export function removeTerminal(id: string): void {
  const entry = terminals.get(id);
  if (entry === undefined) throw new TerminalError("session not found", 404);
  if (entry.record.status === "running") {
    throw new TerminalError("stop the session before removing it", 409);
  }
  terminals.delete(id);
  listeners.delete(id);
}

/**
 * Fail sessions that claim to be running but have no process attached.
 * A restart would otherwise leave them "running" forever.
 */
export function reconcileTerminals(): void {
  for (const entry of terminals.values()) {
    if (entry.record.status !== "running") continue;
    // A live process is either a child process or a pseudo-terminal handle; both mean the session
    // is alive and must not be reconciled as interrupted.
    if (entry.child !== null) continue;
    if (entry.pty !== null) continue;
    entry.record.status = "failed";
    entry.record.endedAt = new Date().toISOString();
    entry.record.error = "the session was interrupted (the server restarted)";
    appendOutput(entry.record, "\n— the session was interrupted; no process is attached\n");
    notify({ type: "exit", id: entry.record.id, code: null, signal: null });
  }
}

/** Drop finished sessions and their buffers. Mostly useful for tests and Housekeeping. */
export function clearTerminals(): void {
  for (const [id, entry] of terminals) {
    if (entry.record.status === "running") continue;
    terminals.delete(id);
    listeners.delete(id);
  }
}
