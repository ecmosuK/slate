import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import { projectFolder } from "./projects";

export type JobMode = "plan" | "build";
export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface JobSummary {
  id: string;
  project: string;
  task: string;
  mode: JobMode;
  model: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  sessionID: string | null;
  error: string | null;
  command: string;
}

export interface JobDetail extends JobSummary {
  log: string;
}

interface JobRecord extends JobSummary {
  log: string;
  stopReason: "cancelled" | "timeout" | null;
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
function resolveOpencodeBinary(): string | null {
  const override = process.env.SLATE_OPENCODE_BIN?.trim();
  if (override !== undefined && override !== "") {
    if (isAbsolute(override) && !existsSync(override)) return null;
    return override;
  }

  if (process.platform !== "win32") return "opencode";

  const candidates: string[] = [];
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData !== "") {
    candidates.push(join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") {
    candidates.push(join(localAppData, "Programs", "opencode", "opencode.exe"));
  }

  // A global npm install also leaves opencode.cmd next to node_modules.
  try {
    const lines = execFileSync("where.exe", ["opencode"], {
      encoding: "utf8",
      windowsHide: true,
    }).split(/\r?\n/);
    for (const line of lines) {
      const path = line.trim();
      if (!path.toLowerCase().endsWith("opencode.cmd")) continue;
      candidates.push(join(dirname(path), "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
    }
  } catch {
    // `where` missing or no global install; the candidates above are still worth checking.
  }

  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

function quoteForDisplay(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
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

/** Start one opencode run in a project folder. One running job per project. */
export function startJob(input: StartJobInput): JobSummary {
  const project = input.project;
  const folder = projectFolder(project);
  if (folder === null || !existsSync(folder)) {
    throw new JobError("project not found", 404);
  }

  const task = input.task.trim();
  if (task === "") throw new JobError("a task description is required");
  if (task.length > 8000) throw new JobError("the task is too long (8000 characters max)");
  if (input.mode !== "plan" && input.mode !== "build") {
    throw new JobError("mode must be plan or build");
  }

  const running = [...jobs.values()].find(
    (entry) => entry.record.project === project && entry.record.status === "running",
  );
  if (running !== undefined) {
    throw new JobError("a task is already running for this project", 409);
  }

  const binary = resolveOpencodeBinary();
  if (binary === null) {
    throw new JobError(
      "opencode CLI not found. Install it, or set SLATE_OPENCODE_BIN to the executable.",
      503,
    );
  }

  const model = input.model?.trim() === "" ? null : (input.model?.trim() ?? null);
  if (model !== null && model.length > 200) throw new JobError("the model name is too long");

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
  ];
  if (model !== null) args.push("--model", model);
  args.push(task);

  const now = new Date().toISOString();
  const record: JobRecord = {
    id: randomUUID(),
    project,
    task,
    mode: input.mode,
    model,
    status: "running",
    createdAt: now,
    startedAt: now,
    endedAt: null,
    exitCode: null,
    sessionID: null,
    error: null,
    command: [binary, ...args].map(quoteForDisplay).join(" "),
    log: "",
    stopReason: null,
  };

  const entry: JobEntry = { record, child: null, timer: null };
  jobs.set(record.id, entry);
  prune();

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
  };

  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      cwd: folder,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append(record, `could not start opencode: ${message}`);
    finish("failed", null, message);
    return publicSummary(record);
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
    killTree(entry.child);
  }, timeoutMilliseconds());
  entry.timer.unref();

  return publicSummary(record);
}

export function listJobs(project?: string): JobSummary[] {
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
  if (entry.record.status !== "running") return publicSummary(entry.record);
  entry.record.stopReason = "cancelled";
  append(entry.record, "\n— cancellation requested");
  killTree(entry.child);
  return publicSummary(entry.record);
}
