import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { capForModel, readConfig, type SlateConfig } from "@slate/shared";
import { DEFAULT_JOB_MODEL } from "./job-defaults";
import { resolveOpencodeBinary } from "./opencode-binary";
import { projectFolder } from "./projects";
import { spentMicrosForModel } from "./spend";

export type JobMode = "plan" | "build";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** The process spawner used for job runs. Tests replace it. */
export type JobSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ("ignore" | "pipe")[];
    windowsHide: boolean;
  },
) => ChildProcess;

let spawnImpl: JobSpawn = spawn;

/** Replace the spawner used for job runs. Pass null to restore the real one. */
export function setJobSpawn(fn: JobSpawn | null): void {
  spawnImpl = fn ?? spawn;
}

/** Where a project's folder is looked up. Tests replace it. */
let folderResolver: (slug: string) => string | null = projectFolder;

/** Replace the folder resolver used for job runs. Pass null to restore the real one. */
export function setJobFolderResolver(fn: ((slug: string) => string | null) | null): void {
  folderResolver = fn ?? projectFolder;
}

/** Where the opencode executable is found. Tests replace it. */
let binaryResolver: () => string | null = resolveOpencodeBinary;

/** Replace the opencode binary lookup. Pass null to restore the real one. */
export function setJobBinaryResolver(fn: (() => string | null) | null): void {
  binaryResolver = fn ?? resolveOpencodeBinary;
}

/** How a run's process tree is stopped. Tests replace it. */
let killImpl: (child: ChildProcess | null) => void = killTree;

/** Replace the process-tree killer. Pass null to restore the real one. */
export function setJobKill(fn: ((child: ChildProcess | null) => void) | null): void {
  killImpl = fn ?? killTree;
}

export interface JobSummary {
  id: string;
  project: string;
  task: string;
  mode: JobMode;
  model: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  sessionID: string | null;
  error: string | null;
  command: string;
  /** What the run cost, in millionths of a dollar. Zero when not measured. */
  costMicros: number;
}

export interface JobDetail extends JobSummary {
  log: string;
}

interface JobRecord extends JobSummary {
  log: string;
  stopReason: "cancelled" | "timeout" | null;
  folder: string;
  args: string[];
  binary: string;
}

interface JobEntry {
  record: JobRecord;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
}

export class JobError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "JobError";
    this.status = status;
  }
}

const MAX_LOG_CHARS = 200_000;
const MAX_JOBS = 40;
const DEFAULT_TIMEOUT_MINUTES = 30;

const store = globalThis as unknown as { __slateJobs?: Map<string, JobEntry> };
const jobs = store.__slateJobs ?? new Map<string, JobEntry>();
store.__slateJobs = jobs;

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** One opencode `step_finish` event's reported cost, in millionths of a dollar. */
export function costMicrosFromEvent(line: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const event = parsed as { type?: unknown; part?: unknown };
  if (event.type !== "step_finish") return null;
  const part =
    event.part !== null && typeof event.part === "object"
      ? (event.part as Record<string, unknown>)
      : null;
  if (part === null) return null;
  const cost = part["cost"];
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
  return Math.round(cost * 1_000_000);
}

/**
 * Refuse to start a job on a model whose recorded spend has reached its configured cap.
 * Spend is the total charged to the model across every job (and chat turn) so far.
 */
export function enforceModelCap(model: string, config: SlateConfig): void {
  const cap = capForModel(config, model);
  if (cap === null) return;
  const spent = spentMicrosForModel(model) / 1_000_000;
  if (spent < cap) return;
  throw new JobError(
    `${model} has reached its spend cap of $${cap.toFixed(2)} (spent $${spent.toFixed(4)}). ` +
      "Raise or remove the cap in Settings, or choose another model.",
    409,
  );
}

function append(record: JobRecord, text: string): void {
  const line = stripAnsi(text).trimEnd();
  if (line === "") return;
  record.log += line.endsWith("\n") ? line : `${line}\n`;
  if (record.log.length > MAX_LOG_CHARS) {
    record.log = `[earlier output truncated]\n${record.log.slice(-MAX_LOG_CHARS)}`;
  }
}

function publicSummary(record: JobRecord): JobSummary {
  return {
    id: record.id,
    project: record.project,
    task: record.task,
    mode: record.mode,
    model: record.model,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    sessionID: record.sessionID,
    error: record.error,
    command: record.command,
    costMicros: record.costMicros,
  };
}

function publicDetail(record: JobRecord): JobDetail {
  return { ...publicSummary(record), log: record.log };
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, entry] of jobs) {
    if (entry.record.status === "running") continue;
    jobs.delete(id);
    if (jobs.size <= MAX_JOBS) break;
  }
}

/** OpenCode is installed by npm on Windows; spawn its exe rather than the .cmd shim. */
function quoteForDisplay(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Stop a process tree the way job runs do (tests can replace the killer). */
export function killProcessTree(child: ChildProcess | null): void {
  killImpl(child);
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

function timeoutMilliseconds(): number {
  const raw = process.env.SLATE_JOB_TIMEOUT_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const minutes =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, 240)
      : DEFAULT_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

/** Turn one `opencode run --format json` line into readable output for the job log. */
export function formatOpencodeEvent(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return line.trim() === "" ? null : line;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const event = parsed as { type?: unknown; part?: unknown; error?: unknown };
  const type = typeof event.type === "string" ? event.type : "";
  const part =
    event.part !== null && typeof event.part === "object"
      ? (event.part as Record<string, unknown>)
      : null;

  if (type === "text" && part !== null && typeof part.text === "string") {
    return part.text;
  }

  if (type === "tool_use" && part !== null) {
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    const state =
      part.state !== null && typeof part.state === "object"
        ? (part.state as Record<string, unknown>)
        : null;
    const input =
      state?.input !== null && typeof state?.input === "object"
        ? (state.input as Record<string, unknown>)
        : null;
    const output = typeof state?.output === "string" ? state.output.trim() : "";
    const failure = typeof state?.error === "string" ? state.error.trim() : "";

    if (tool === "shell") {
      const command = typeof input?.command === "string" ? input.command : "";
      const result = failure !== "" ? `error: ${failure}` : output;
      return `[shell] ${command}${result === "" ? "" : `\n${clip(result, 1500)}`}`;
    }

    const path =
      typeof input?.path === "string"
        ? input.path
        : typeof input?.filePath === "string"
          ? input.filePath
          : "";
    if (failure !== "") return `[${tool}] ${path}\nerror: ${failure}`;
    return path === "" ? `[${tool}]` : `[${tool}] ${path}`;
  }

  if (type === "step_finish" && part !== null) {
    const cost = typeof part.cost === "number" && part.cost > 0 ? ` · $${part.cost.toFixed(4)}` : "";
    return `— step finished${cost}`;
  }

  if (type === "error") {
    return `error: ${typeof event.error === "string" ? event.error : JSON.stringify(event.error)}`;
  }

  return null;
}

export interface StartJobInput {
  project: string;
  task: string;
  mode: JobMode;
  model?: string | null;
}

function startNextQueued(project: string): void {
  const running = [...jobs.values()].some(
    (entry) => entry.record.project === project && entry.record.status === "running",
  );
  if (running) return;
  const next = [...jobs.values()]
    .filter((entry) => entry.record.project === project && entry.record.status === "queued")
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))[0];
  if (next === undefined) return;
  launchJob(next, true);
}

/**
 * Fail jobs that claim to be running but have no process attached.
 *
 * A run whose child is gone (the server restarted, the process was killed elsewhere) would
 * otherwise sit at "running" forever and block the queue behind it.
 */
export function reconcileJobs(): void {
  for (const entry of jobs.values()) {
    if (entry.record.status !== "running") continue;
    if (entry.child !== null) continue;
    entry.record.status = "failed";
    entry.record.endedAt = new Date().toISOString();
    entry.record.error = "the run was interrupted (the server restarted)";
    append(entry.record, "\n— the run was interrupted; no process is attached to this job");
  }
}

function launchJob(entry: JobEntry, fromQueue: boolean): void {
  const { record } = entry;
  // A job that already has a child process is running; do not launch it twice.
  if (entry.child !== null) return;
  if (record.status === "running") return;

  record.status = "running";
  record.startedAt = new Date().toISOString();
  record.stopReason = null;
  append(record, fromQueue ? "— starting queued task" : "— starting task");

  let finished = false;
  const finish = (status: JobStatus, code: number | null, error: string | null): void => {
    if (finished) return;
    finished = true;
    record.status = status;
    record.exitCode = code;
    record.endedAt = new Date().toISOString();
    if (error !== null) record.error = error;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.child = null;
    // Advance the queue for this project.
    startNextQueued(record.project);
  };

  let child: ChildProcess;
  try {
    child = spawnImpl(record.binary, record.args, {
      cwd: record.folder,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(record, `could not start opencode: ${message}`);
    finish("failed", null, message);
    return;
  }

  entry.child = child;

  if (child.stdout !== null) {
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (record.sessionID === null) {
        try {
          const event = JSON.parse(line) as { sessionID?: unknown };
          if (typeof event.sessionID === "string") record.sessionID = event.sessionID;
        } catch {
          // Not every line has to be JSON; the formatter will keep raw text.
        }
      }
      const micros = costMicrosFromEvent(line);
      if (micros !== null) record.costMicros += micros;
      const readable = formatOpencodeEvent(line);
      if (readable !== null) append(record, readable);
    });
  }

  if (child.stderr !== null) {
    const errors = createInterface({ input: child.stderr });
    errors.on("line", (line) => {
      const readable = stripAnsi(line).trim();
      if (readable !== "") append(record, `stderr: ${clip(readable, 1200)}`);
    });
  }

  child.on("error", (error) => {
    append(record, `opencode error: ${error.message}`);
    finish("failed", null, error.message);
  });

  child.on("close", (code, signal) => {
    if (record.stopReason === "timeout") {
      finish("failed", code, record.error ?? "the task timed out");
      return;
    }
    if (record.stopReason === "cancelled") {
      finish("cancelled", code, null);
      return;
    }
    if (code === 0) {
      finish("succeeded", code, null);
      return;
    }
    finish(
      "failed",
      code,
      `opencode exited with code ${code === null ? "unknown" : String(code)}${
        signal === null ? "" : ` (${signal})`
      }`,
    );
  });

  entry.timer = setTimeout(() => {
    if (record.status !== "running") return;
    record.stopReason = "timeout";
    record.error = `timed out after ${Math.round(timeoutMilliseconds() / 60000)} minutes`;
    append(record, `\n— ${record.error}; stopping opencode`);
    killImpl(entry.child);
  }, timeoutMilliseconds());
  entry.timer.unref();
}

/** Start or queue an opencode run in a project folder. Server-side queue per project. */
export function startJob(input: StartJobInput): JobSummary {
  const project = input.project;
  const folder = folderResolver(project);
  if (folder === null || !existsSync(folder)) {
    throw new JobError("project not found", 404);
  }

  const task = input.task.trim();
  if (task === "") throw new JobError("a task description is required");
  if (task.length > 8000) throw new JobError("the task is too long (8000 characters max)");
  if (input.mode !== "plan" && input.mode !== "build") {
    throw new JobError("mode must be plan or build");
  }

  const binary = binaryResolver();
  if (binary === null) {
    throw new JobError(
      "opencode CLI not found. Install it, or set SLATE_OPENCODE_BIN to the executable.",
      503,
    );
  }

  const requested = input.model?.trim() ?? "";
  const model = requested === "" ? DEFAULT_JOB_MODEL : requested;
  if (model.length > 200) throw new JobError("the model name is too long");

  enforceModelCap(model, readConfig());

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const args = [
    "run",
    "--format",
    "json",
    "--archived",
    "--title",
    `Slate · ${project} · ${timestamp}`,
    "--agent",
    input.mode === "plan" ? "plan" : "build",
    "--model",
    model,
  ];
  args.push(task);

  const now = new Date().toISOString();

  // A job left "running" without a process would block the queue; clear those first.
  reconcileJobs();

  const hasRunning = [...jobs.values()].some(
    (entry) => entry.record.project === project && entry.record.status === "running",
  );

  const record: JobRecord = {
    id: randomUUID(),
    project,
    task,
    mode: input.mode,
    model,
    // The record starts queued; launchJob is what moves it to running, so there is exactly one
    // place that starts a process.
    status: "queued",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    sessionID: null,
    error: null,
    command: [binary, ...args].map(quoteForDisplay).join(" "),
    costMicros: 0,
    log: hasRunning ? "— queued (waiting for current task to finish)\n" : "",
    stopReason: null,
    folder,
    args,
    binary,
  };

  const entry: JobEntry = { record, child: null, timer: null };
  jobs.set(record.id, entry);
  prune();

  if (!hasRunning) {
    launchJob(entry, false);
  }
  return publicSummary(record);
}

export function listJobs(project?: string): JobSummary[] {
  // Clear any run that lost its process, so a stale job cannot block the queue.
  reconcileJobs();
  const wanted = project === undefined ? null : project;
  return [...jobs.values()]
    .filter((entry) => wanted === null || entry.record.project === wanted)
    .map((entry) => publicSummary(entry.record))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getJob(id: string): JobDetail | null {
  const entry = jobs.get(id);
  return entry === undefined ? null : publicDetail(entry.record);
}

export function cancelJob(id: string): JobSummary {
  const entry = jobs.get(id);
  if (entry === undefined) throw new JobError("job not found", 404);
  if (entry.record.status === "queued") {
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    entry.record.stopReason = "cancelled";
    append(entry.record, "\n— removed from queue");
    return publicSummary(entry.record);
  }
  if (entry.record.status !== "running") return publicSummary(entry.record);

  entry.record.stopReason = "cancelled";
  append(entry.record, "\n— cancellation requested");

  // A run with no process attached cannot be killed; nothing would ever close it, so finish it here.
  if (entry.child === null) {
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    append(entry.record, "\n— no process was running");
    return publicSummary(entry.record);
  }

  killImpl(entry.child);

  // Safety net: if the process refuses to die, the run must not stay "running" forever.
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.record.status !== "running") return;
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    append(entry.record, "\n— the process did not stop in time; the run was closed");
    startNextQueued(entry.record.project);
  }, 5000);
  entry.timer.unref();

  return publicSummary(entry.record);
}

/** Remove a finished run from the history. Running and queued jobs must be stopped first. */
export function deleteJob(id: string): void {
  const entry = jobs.get(id);
  if (entry === undefined) throw new JobError("job not found", 404);
  if (entry.record.status === "running" || entry.record.status === "queued") {
    throw new JobError("stop the run before deleting it", 409);
  }
  jobs.delete(id);
}
