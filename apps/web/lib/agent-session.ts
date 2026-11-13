/**
 * One agentic chat session per project, run through the local opencode CLI.
 *
 * The chat no longer ships a conversation to a model and gets a reply back: it starts a run in
 * the project's own folder, where the same agent a person would use in opencode can read, write,
 * edit and run commands. Slate's plan and goal tools reach that agent through a local MCP server
 * (`packages/agent-tools/src/mcp-server.ts`), so the plan block and `goals.json` stay validated
 * instead of becoming free-form file edits.
 *
 * One run per project at a time, one persistent opencode session id per project folder, and a
 * buffered event list so a browser that connects late still sees the whole turn.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configDir, geminiKey, openRouterKey, readConfig, toOpencodeModelId } from "@slate/shared";

import { enforceModelCap, killProcessTree } from "./jobs";
import { resolveOpencodeBinary } from "./opencode-binary";
import { projectFolder, projectsRoot } from "./projects";
import { recordChatSpend } from "./spend";

export type AgentRunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Per-model availability: a model that recently failed with a free/rate limit is recorded here. */
// Route bundles are compiled separately in dev, so keep this on globalThis (like the run store):
// the agent route writes it and /api/models reads it.
const availabilityStore = globalThis as unknown as {
  __slateModelAvailability?: Map<string, { reason: string; until: number }>;
};
const modelUnavailability =
  availabilityStore.__slateModelAvailability ??
  new Map<string, { reason: string; until: number }>();
availabilityStore.__slateModelAvailability = modelUnavailability;

export function markModelUnavailable(model: string, reason: string, until: number): void {
  if (model === "") return;
  modelUnavailability.set(model, { reason, until });
}

export function modelUnavailabilityOf(model: string): { reason: string; until: number } | null {
  const entry = modelUnavailability.get(model);
  if (entry === undefined) return null;
  if (Date.now() > entry.until) {
    modelUnavailability.delete(model);
    return null;
  }
  return entry;
}

/**
 * The request size (input + cached tokens) of the last step in a folder.
 *
 * It is kept in its own file beside the session ids so it survives a server restart; without
 * that, a bloated session would silently pass the auto-reset threshold check after every restart.
 */
export function lastContextTokens(folder: string): number {
  return readContextMap()[folder] ?? 0;
}

/** How large a request may grow before the next turn starts a fresh session. */
export function contextLimitTokens(): number {
  const raw = process.env["SLATE_AGENT_CONTEXT_LIMIT"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_LIMIT;
}

/** Drop the stored session id for a folder, so the next run starts a fresh session. */
export function clearStoredSessionId(folder: string): void {
  try {
    const path = sessionsPath();
    const map = readSessionMap();
    delete map[folder];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // Best effort.
  }
  try {
    const path = contextPath();
    const map = readContextMap();
    delete map[folder];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // Best effort.
  }
}

/** Whether the most recent run in a folder overflowed the context limit. */
export function lastRunOverflowed(folder: string): boolean {
  for (const entry of runs.values()) {
    if (entry.record.folder === folder) return entry.flags.contextOverflow;
  }
  return false;
}

export function clearExpiredModelUnavailability(): void {
  const now = Date.now();
  for (const [model, entry] of modelUnavailability) {
    if (now > entry.until) modelUnavailability.delete(model);
  }
}
export type AgentFocus = "chat" | "goals";

export interface AgentToolCard {
  /** The opencode part id; later updates of the same call replace this card in place. */
  id: string;
  tool: string;
  /** One line: the path, command or question the tool dealt with. */
  title: string;
  /** A short excerpt of the tool's output (or its error). */
  detail: string;
  status: "running" | "completed" | "error";
}

export type AgentEvent =
  | { type: "text"; id: string; text: string }
  | { type: "tool"; card: AgentToolCard }
  /** Cumulative cost of the run, in millionths of a dollar. */
  | { type: "cost"; micros: number }
  | { type: "context"; tokens: number }
  | { type: "error"; message: string }
  | { type: "done"; status: AgentRunStatus; error: string | null };

export interface AgentRunSummary {
  id: string;
  project: string | null;
  folder: string;
  prompt: string;
  model: string;
  focus: AgentFocus;
  status: AgentRunStatus;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  costMicros: number;
  contextTokens: number;
  error: string | null;
  command: string;
}

export interface AgentRunDetail extends AgentRunSummary {
  events: AgentEvent[];
}

export class AgentRunError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AgentRunError";
    this.status = status;
  }
}

/** How the CLI is started. Tests replace it. */
export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ("pipe" | "ignore")[];
    windowsHide: boolean;
  },
) => ChildProcess;

let spawnImpl: AgentSpawn = spawn;

/** Replace the spawner used by chat runs. Pass null to restore the real one. */
export function setAgentSpawn(fn: AgentSpawn | null): void {
  spawnImpl = fn ?? spawn;
}

/** How a run's process tree is stopped. Tests replace it. */
let killImpl: (child: ChildProcess | null) => void = killProcessTree;

/** Replace the process-tree killer. Pass null to restore the real one. */
export function setAgentKill(fn: ((child: ChildProcess | null) => void) | null): void {
  killImpl = fn ?? killProcessTree;
}

/** Where the opencode executable is found. Tests replace it. */
let binaryResolver: () => string | null = resolveOpencodeBinary;

/** Replace the binary lookup. Pass null to restore the real one. */
export function setAgentBinaryResolver(fn: (() => string | null) | null): void {
  binaryResolver = fn ?? resolveOpencodeBinary;
}

/** Where a project's folder is looked up. Tests replace it. */
let folderResolver: (slug: string) => string | null = projectFolder;

/** Replace the folder resolver. Pass null to restore the real one. */
export function setAgentFolderResolver(fn: ((slug: string) => string | null) | null): void {
  folderResolver = fn ?? projectFolder;
}

/** The projects root a run works under. Tests replace it. */
let rootResolver: () => string = projectsRoot;

/** Replace the projects root resolver. Pass null to restore the real one. */
export function setAgentRootResolver(fn: (() => string) | null): void {
  rootResolver = fn ?? projectsRoot;
}

/** Look up the folder for a project slug, using the injected resolver. */
export function agentFolder(slug: string): string | null {
  return folderResolver(slug);
}

const MAX_EVENTS = 4000;
const MAX_RUNS = 30;
const MAX_PROMPT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MINUTES = 30;
/**
 * A request above this size is rotated onto a fresh session before it is sent.
 *
 * Gemini's free tier counts input tokens per minute, not per request: a big session re-sent by
 * several agent steps in one minute runs past 250k even when no single request is that large.
 * 80k leaves room for a few steps while keeping a single turn well under the limit.
 */
const DEFAULT_CONTEXT_LIMIT = 80_000;

interface AgentRunEntry {
  record: AgentRunSummary;
  events: AgentEvent[];
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  listeners: Set<(event: AgentEvent) => void>;
  flags: {
    stopped: boolean;
    timedOut: boolean;
    lastError: string | null;
    contextTokens: number;
    contextOverflow: boolean;
    /** A context overflow dropped the session; later lines must not store its id again. */
    sessionReset: boolean;
  };
}

const store = globalThis as unknown as { __slateAgentRuns?: Map<string, AgentRunEntry> };
const runs = store.__slateAgentRuns ?? new Map<string, AgentRunEntry>();
store.__slateAgentRuns = runs;

// Colour codes in CLI output: built from the escape character itself so this file stays plain
// ASCII-safe text.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function clip(text: string, limit: number): string {
  const clean = stripAnsi(text).trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

/**
 * The repository this server runs from: the folder that holds `packages/agent-tools`, where the
 * MCP server entry point lives. opencode starts the MCP server in its own process, so its path
 * has to be absolute and known here rather than resolved by the CLI.
 */
export function slateRepoRoot(): string {
  const override = process.env["SLATE_REPO_ROOT"]?.trim();
  if (override !== undefined && override !== "") return override;

  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "packages", "agent-tools", "src", "mcp-server.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Where the opencode session id per project folder is remembered across restarts. */
function sessionsPath(): string {
  const override = process.env["SLATE_AGENT_SESSIONS"]?.trim();
  if (override !== undefined && override !== "") return override;
  return join(configDir(), "agent-sessions.json");
}

/** Where the last request size per folder is remembered. Tests keep it beside the sessions file. */
function contextPath(): string {
  const override = process.env["SLATE_AGENT_CONTEXT"]?.trim();
  if (override !== undefined && override !== "") return override;
  const sessions = process.env["SLATE_AGENT_SESSIONS"]?.trim();
  if (sessions !== undefined && sessions !== "") return `${sessions}.context`;
  return join(configDir(), "agent-session-context.json");
}

function readContextMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(contextPath(), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function rememberContextTokens(folder: string, tokens: number): void {
  if (folder === "") return;
  try {
    const path = contextPath();
    const map = readContextMap();
    if (map[folder] === tokens) return;
    mkdirSync(dirname(path), { recursive: true });
    map[folder] = tokens;
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // A size that is not remembered only delays a future reset.
  }
}

function readSessionMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(sessionsPath(), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.startsWith("ses_")) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

/** The opencode session this folder has been chatting in, or null on a first run. */
export function storedSessionId(folder: string): string | null {
  return readSessionMap()[folder] ?? null;
}

function storeSessionId(folder: string, sessionId: string): void {
  try {
    const path = sessionsPath();
    const map = readSessionMap();
    if (map[folder] === sessionId) return;
    mkdirSync(dirname(path), { recursive: true });
    map[folder] = sessionId;
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // A session that is not remembered only costs context on the next run.
  }
}

/**
 * Where the run's opencode config is written: `<folder>/.opencode/opencode.json`.
 *
 * The CLI v2 reads project config from files on disk only — it ignores config environment
 * variables — so the slate MCP server has to live in a file the run's working directory picks
 * up. The `.opencode` folder is opencode's own per-project config directory, which keeps the
 * project root clean; anything else already in the file (a user's `mcp.servers`, a default
 * model) is preserved, and only the `slate` server entry is ours to rewrite.
 */
function projectConfigPath(folder: string): string {
  return join(folder, ".opencode", "opencode.json");
}

/**
 * Make sure this folder's opencode config points at the slate MCP server for this run.
 *
 * The agent keeps its normal tools (`--auto` approves what it asks for); the two Slate files
 * stay protected, because they are changed through the validated tools the MCP server exposes.
 */
function writeMcpConfig(root: string, project: string | null, folder: string): void {
  const server = join(slateRepoRoot(), "packages", "agent-tools", "src", "mcp-server.ts");
  const path = projectConfigPath(folder);

  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // A first run, or a file that is not valid JSON: start from the schema line and keep going.
  }
  if (config["$schema"] === undefined) config["$schema"] = "https://opencode.ai/config.json";

  // The plan agent (Slate's goals chat) must not touch project files: it may only
  // manage goals and plan tasks through the slate MCP tools. Override the built-in
  // `plan` agent so edit/bash (and friends) are denied even if the model tries.
  const agents = asRecord(config["agents"]) ?? {};
  agents["plan"] = {
    ...(asRecord(agents["plan"]) ?? {}),
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "deny" },
      { action: "glob", resource: "*", effect: "deny" },
      { action: "grep", resource: "*", effect: "deny" },
      { action: "list", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "todowrite", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "lsp", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "deny" },
    ],
    tools: {
      write: false,
      edit: false,
      bash: false,
      shell: false,
      read: false,
      glob: false,
      grep: false,
      list: false,
      webfetch: false,
      websearch: false,
      task: false,
      lsp: false,
      external_directory: false,
      todowrite: false,
      question: false,
    },
  };
  config["agents"] = agents;

  const mcp = asRecord(config["mcp"]) ?? {};
  const servers = asRecord(mcp["servers"]) ?? {};
  servers["slate"] = {
    type: "local",
    command: [process.execPath, server],
    cwd: root,
    environment: {
      SLATE_ROOT: root,
      SLATE_PROJECT: project ?? "",
      SLATE_MCP_FOLDER: folder,
      SLATE_AGENT: "slate-agent",
    },
  };
  mcp["servers"] = servers;
  config["mcp"] = mcp;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    // Without the file the run still works, just without the plan and goal tools.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`slate: could not write ${path}: ${message}`);
  }
}

const PLAN_TOOL_NAMES = new Set([
  "list_projects",
  "read_project",
  "create_project",
  "update_plan",
  "add_tasks",
  "complete_task",
  "reorder_tasks",
  "move_task",
  "add_goal",
  "update_goal",
  "reorder_goals",
]);

/** Whether a tool card describes a change to a plan or to the goals checklist. */
export function isPlanTool(tool: string): boolean {
  const name = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return PLAN_TOOL_NAMES.has(name);
}

/**
 * The message the run actually sends: who the agent is, plus the user's words.
 *
 * The project's AGENTS.md is read by the CLI itself, so this only says what Slate-specific
 * behaviour the chat expects on top of it.
 */
export function buildPrompt(prompt: string, focus: AgentFocus): string {
  const preamble =
    focus === "goals"
      ? [
          "You are Slate's plan agent for this project.",
          "Workshop ideas and clarify goals before acting, unless the request is already specific.",
          "Goals live in goals.json and carry a priority (high, medium, low) and an order: the list",
          "reads top to bottom, so goal one is done before goal two. Plan tasks live in the README",
          "plan block (Now/Next/Done) and must stay in priority order.",
          "Manage goals and plan tasks with the slate MCP tools (add_goal, update_goal,",
          "reorder_goals, add_tasks, reorder_tasks, move_task, read_project). Do not edit",
          "goals.json or the README plan block by hand, do not create projects, and do not change",
          "plan metadata (goal/status/milestone/log) or mark tasks complete.",
          "When you finish, reply in plain language: say what changed. Do not mention tool names,",
          "command syntax, JSON, logs, costs, or technical details.",
          "",
        ].join("\n")
      : [
          "You are Slate's project agent, working in this project's own folder.",
          "Read, edit and run whatever the request needs. Keep the README plan block and",
          "goals.json current through the slate MCP tools (update_plan, add_tasks, complete_task,",
          "add_goal, update_goal, read_project, ...) rather than editing those two files by hand —",
          "Slate renders them and needs them well-formed. Everything else you may edit freely.",
          "",
        ].join("\n");
  return `${preamble}\n${prompt}`;
}

function timeoutMilliseconds(): number {
  const raw = process.env["SLATE_AGENT_TIMEOUT_MINUTES"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const minutes =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 240) : DEFAULT_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

function publicSummary(entry: AgentRunEntry): AgentRunSummary {
  return { ...entry.record };
}

function publicDetail(entry: AgentRunEntry): AgentRunDetail {
  return { ...entry.record, events: [...entry.events] };
}

function pruneRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  for (const [id, entry] of runs) {
    if (entry.record.status === "running") continue;
    runs.delete(id);
    if (runs.size <= MAX_RUNS) break;
  }
}

/**
 * Fail runs that claim to be running with no process attached (the dev server restarted under
 * them). They would otherwise block their project forever.
 */
export function reconcileAgentRuns(): void {
  for (const entry of runs.values()) {
    if (entry.record.status !== "running" || entry.child !== null) continue;
    entry.record.status = "failed";
    entry.record.endedAt = new Date().toISOString();
    entry.record.error = "the run was interrupted (the server restarted)";
    emit(entry, { type: "done", status: "failed", error: entry.record.error });
  }
}

function emit(entry: AgentRunEntry, event: AgentEvent): void {
  if (entry.events.length < MAX_EVENTS) entry.events.push(event);
  for (const listener of [...entry.listeners]) {
    try {
      listener(event);
    } catch {
      // A listener that throws (a closed stream) must not stop the run.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The one line a tool card shows: whatever the tool was pointed at. */
function textOf(input: unknown): string {
  const row = asRecord(input);
  if (row === null) return "";
  const keys = ["path", "filePath", "command", "pattern", "project", "title", "task", "prompt", "query"];
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return clip(value, 300);
  }
  return "";
}

function cardFromPart(part: Record<string, unknown>): AgentToolCard {
  const tool = typeof part["tool"] === "string" ? part["tool"] : "tool";
  const id = typeof part["id"] === "string" ? part["id"] : randomUUID();
  const state = asRecord(part["state"]);
  const status = typeof state?.["status"] === "string" ? state["status"] : "completed";
  const failure = typeof state?.["error"] === "string" ? state["error"] : "";
  const output = typeof state?.["output"] === "string" ? state["output"] : "";

  const title = textOf(state?.["input"]);
  const detail =
    failure !== ""
      ? clip(failure, 600)
      : output !== ""
        ? clip(output, 600)
        : status === "running"
          ? "running…"
          : "";

  return {
    id,
    tool,
    title,
    detail,
    status:
      status === "running" ? "running" : status === "error" || failure !== "" ? "error" : "completed",
  };
}

export interface ParsedAgentLine {
  sessionId: string | null;
  event: AgentEvent | null;
  /** Structured info about a provider-level failure, if this line carried one. */
  modelError: { type: string; retryAfterMs: number | null } | null;
  /** The request size in tokens, when this line carried a `step_finish` with token counts. */
  contextTokens?: number;
}

/**
 * Turn one `opencode run --format json` line into an event.
 *
 * Text parts arrive whole (not as deltas), each with its own part id, so the transcript keys
 * text blocks by id: a repeat of the same id replaces its block, a new id appends one.
 */
export function parseAgentLine(line: string, costSoFar: number): ParsedAgentLine {
  const trimmed = line.trim();
  if (trimmed === "") return { sessionId: null, event: null, modelError: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { sessionId: null, event: null, modelError: null };
  }
  const row = asRecord(parsed);
  if (row === null) return { sessionId: null, event: null, modelError: null };

  const rawSession = row["sessionID"];
  const sessionId =
    typeof rawSession === "string" && rawSession.startsWith("ses_") ? rawSession : null;
  const part = asRecord(row["part"]);
  const type = row["type"];

  if (type === "text") {
    if (part === null || typeof part["text"] !== "string") return { sessionId, event: null, modelError: null };
    const id = typeof part["id"] === "string" ? part["id"] : randomUUID();
    return { sessionId, event: { type: "text", id, text: part["text"] }, modelError: null };
  }

  if (type === "tool_use") {
    if (part === null) return { sessionId, event: null, modelError: null };
    return { sessionId, event: { type: "tool", card: cardFromPart(part) }, modelError: null };
  }

  if (type === "step_finish") {
    const cost = part === null ? undefined : part["cost"];
    const tokens = part === null ? undefined : asRecord(part["tokens"]);
    const input = typeof tokens?.["input"] === "number" ? tokens["input"] : 0;
    const cacheRecord = asRecord(tokens?.["cache"]);
    const cacheRead = typeof cacheRecord?.["read"] === "number" ? (cacheRecord as { read: number })["read"] : 0;
    const context = input + cacheRead;
    const withContext = (event: AgentEvent | null): ParsedAgentLine =>
      context > 0
        ? { sessionId, event, modelError: null, contextTokens: context }
        : { sessionId, event, modelError: null };
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
      return withContext(null);
    }
    const micros = Math.round(cost * 1_000_000);
    if (micros <= 0) return withContext(null);
    return withContext({ type: "cost", micros: costSoFar + micros });
  }

  if (type === "error") {
    const error = row["error"];
    const errorRecord = asRecord(error);
    const message =
      typeof error === "string"
        ? error
        : typeof errorRecord?.["message"] === "string"
          ? (errorRecord as { message: string })["message"]
          : JSON.stringify(error ?? "unknown error");
    const errorType = typeof errorRecord?.["type"] === "string" ? (errorRecord as { type: string })["type"] : null;
    const retryFromField =
      typeof errorRecord?.["retryAfterMs"] === "number" ? (errorRecord as { retryAfterMs: number })["retryAfterMs"] : null;
    const retryFromMessage = /(?:please )?retry in ([\d.]+)\s*(ms|s|minutes?|m)\b/i.exec(message);
    const retryAfterMs =
      retryFromField !== null
        ? retryFromField
        : retryFromMessage === null
          ? null
          : Math.round(
              Number(retryFromMessage[1]) *
                (retryFromMessage[2]?.toLowerCase() === "ms"
                  ? 1
                  : retryFromMessage[2]?.toLowerCase().startsWith("m")
                    ? 60_000
                    : 1_000),
            );
    const modelError =
      errorType !== null &&
      (errorType === "provider.free-limit" ||
        errorType === "provider.rate-limit" ||
        errorType === "provider.quota" ||
        errorType === "provider.no-route")
        ? { type: errorType, retryAfterMs }
        : null;
    return { sessionId, event: { type: "error", message: clip(message, 2000) }, modelError };
  }

  return { sessionId, event: null, modelError: null };
}

function quoteForDisplay(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export interface StartAgentTurnInput {
  /** The UI's project slug, or null for a workspace-wide chat. */
  project: string | null;
  folder: string;
  prompt: string;
  model: string;
  focus?: AgentFocus;
}

/**
 * Start one agent turn in a folder. Only one run per folder at a time: the CLI continues one
 * session, and two concurrent runs would interleave it.
 */
export function startAgentTurn(input: StartAgentTurnInput): AgentRunSummary {
  reconcileAgentRuns();

  const prompt = input.prompt.trim();
  if (prompt === "") throw new AgentRunError("a message is required");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new AgentRunError(`the message is too long (${MAX_PROMPT_CHARS} characters max)`);
  }
  if (!existsSync(input.folder)) throw new AgentRunError("project not found", 404);

  const model = input.model.trim();
  if (model === "") throw new AgentRunError("a model is required");
  if (model.length > 200) throw new AgentRunError("the model name is too long");

  for (const entry of runs.values()) {
    if (entry.record.status !== "running") continue;
    if (entry.record.folder !== input.folder) continue;
    throw new AgentRunError("the agent is already working here; stop it first", 409);
  }

  const binary = binaryResolver();
  if (binary === null) {
    throw new AgentRunError(
      "opencode CLI not found. Install it, or set SLATE_OPENCODE_BIN to the executable.",
      503,
    );
  }

  const config = readConfig();
  enforceModelCap(model, config);

  const focus: AgentFocus = input.focus === "goals" ? "goals" : "chat";
  const projectKey = input.project ?? "__workspace__";

  const args = [
    "run",
    "--format",
    "json",
    "--auto",
    "--title",
    `Slate · ${projectKey} · chat`,
    "--model",
    toOpencodeModelId(model),
  ];
  // A session id must start with "ses_": the first run omits the flag and adopts the id the CLI
  // reports back, which is then remembered for this folder. A session whose last request grew
  // past the context limit is rotated here, before it becomes one enormous prompt.
  const savedSession = storedSessionId(input.folder);
  const savedContext = lastContextTokens(input.folder);
  const sessionId = savedSession !== null && savedContext > contextLimitTokens() ? null : savedSession;
  if (savedSession !== null && sessionId === null) clearStoredSessionId(input.folder);
  if (sessionId !== null) args.push("--session", sessionId);

  // The goals (plan) agent is restricted to the slate MCP tools: no file edits, no shell.
  // See writeMcpConfig's `agents.plan` override.
  if (focus === "goals") args.push("--agent", "plan");

  // The slate MCP server reaches the run through the folder's own config file (see
  // writeMcpConfig): opencode v2 reads project config from disk, not from the environment.
  writeMcpConfig(rootResolver(), input.project, input.folder);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const openRouter = openRouterKey(config);
  if (openRouter !== null && openRouter !== "") env["OPENROUTER_API_KEY"] = openRouter;
  const gemini = geminiKey(config);
  if (gemini !== null && gemini !== "") {
    env["GEMINI_API_KEY"] = gemini;
    env["GOOGLE_GENERATIVE_AI_KEY"] = gemini;
  }

  const now = new Date().toISOString();
  const record: AgentRunSummary = {
    id: randomUUID(),
    project: input.project,
    folder: input.folder,
    prompt,
    model,
    focus,
    status: "running",
    sessionId,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    costMicros: 0,
    contextTokens: 0,
    error: null,
    command: [binary, ...args].map(quoteForDisplay).join(" "),
  };

  const entry: AgentRunEntry = {
    record,
    events: [],
    child: null,
    timer: null,
    listeners: new Set(),
    flags: {
      stopped: false,
      timedOut: false,
      lastError: null,
      contextTokens: 0,
      contextOverflow: false,
      sessionReset: false,
    },
  };
  runs.set(record.id, entry);
  pruneRuns();

  let finished = false;
  const finish = (status: AgentRunStatus, error: string | null): void => {
    if (finished) return;
    finished = true;
    entry.record.status = status;
    entry.record.endedAt = new Date().toISOString();
    entry.record.error = error;
    entry.child = null;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.record.costMicros > 0) recordSpend(entry.record.model, entry.record.costMicros);
    emit(entry, { type: "done", status, error });
  };

  let child: ChildProcess;
  try {
    child = spawnImpl(binary, args, {
      cwd: input.folder,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish("failed", `could not start opencode: ${message}`);
    runs.delete(record.id);
    throw new AgentRunError(`could not start opencode: ${message}`, 503);
  }

  entry.child = child;

  // Kept in the turn's scope so the failure below can quote it, whatever order the streams end.
  let stderrText = "";

  if (child.stdout !== null) {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        handleLine(entry, buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
  }

  if (child.stderr !== null) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrText.length <= 8000) stderrText += chunk;
    });
  }

  child.on("error", (error) => {
    entry.flags.lastError = error.message;
    finish("failed", error.message);
  });

  child.on("close", (code, signal) => {
    if (entry.flags.timedOut) {
      finish("failed", entry.record.error ?? "the run timed out");
      return;
    }
    if (entry.flags.stopped) {
      finish("cancelled", null);
      return;
    }
    if (code === 0) {
      finish("succeeded", null);
      return;
    }
    const reason = failureReason(entry, stderrText, code, signal);
    finish(
      "failed",
      // The CLI sometimes reports a session-size failure only on stderr; translate that path too.
      isContextQuotaMessage(reason) ? rotateOverflowedSession(entry, reason) : reason,
    );
  });

  entry.timer = setTimeout(() => {
    if (entry.record.status !== "running") return;
    entry.flags.timedOut = true;
    entry.record.error = `timed out after ${Math.round(timeoutMilliseconds() / 60000)} minutes`;
    killImpl(entry.child);
  }, timeoutMilliseconds());
  entry.timer.unref();

  // The prompt travels over stdin: Windows caps a command line at 8191 characters.
  if (child.stdin !== null) {
    child.stdin.on("error", () => {
      // The CLI may close stdin early; the close handler reports the real failure.
    });
    child.stdin.end(buildPrompt(prompt, focus), "utf8");
  }

  return publicSummary(entry);
}

/** What a failed run says: the stream's own error, else stderr, else the exit code. */
function failureReason(
  entry: AgentRunEntry,
  stderrText: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const fromError = entry.flags.lastError;
  if (fromError !== null && fromError !== "") return fromError;
  const fromStderr = clip(stderrText, 2000);
  if (fromStderr !== "") return fromStderr;
  return `opencode exited with code ${code === null ? "unknown" : String(code)}${
    signal === null ? "" : ` (${signal})`
  }`;
}

/** Whether a provider failure message describes the session's own request size. */
function isContextQuotaMessage(message: string): boolean {
  return /generate_content_free_tier_input_token_count|input_token_count|per minute limit exceeded/i.test(
    message,
  );
}

/** Whether a provider failure is the session's own request size rather than a model-wide limit. */
export function isContextQuotaError(type: string, message: string): boolean {
  return (type === "provider.quota" || type === "provider.rate-limit") && isContextQuotaMessage(message);
}

/** Rewrite a context-quota failure so it does not read like an exhausted key or allowance. */
export function contextQuotaMessage(message: string, contextTokens: number): string {
  const limitMatch = /limit:\s*([\d,]+)/i.exec(message);
  const parsedLimit =
    limitMatch === null ? Number.NaN : Number.parseInt(limitMatch[1]!.replace(/,/g, ""), 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : null;
  const retryMatch = /(?:please )?retry in ([\d.]+)\s*(ms|s|minutes?|m)\b/i.exec(message);
  const retrySeconds =
    retryMatch === null
      ? null
      : Math.max(
          1,
          Math.ceil(
            Number(retryMatch[1]) *
              (retryMatch[2]?.toLowerCase() === "ms"
                ? 0.001
                : retryMatch[2]?.toLowerCase().startsWith("m")
                  ? 60
                  : 1),
          ),
        );

  const size =
    contextTokens > 0
      ? `This session is sending about ${Math.round(contextTokens / 1000)}k tokens per request`
      : "This session is sending too much context per request";
  const ceiling =
    limit === null
      ? " — over the model's free-tier input-token limit per minute"
      : ` — over the model's free-tier limit of ${limit.toLocaleString("en-US")} input tokens per minute`;
  const retry = retrySeconds === null ? "" : ` (retry in ~${retrySeconds}s)`;

  return `${size}${ceiling}. That is a rate limit, not your allowance running out${retry}. The conversation has grown too long for one request, so a new session was started for this project; your project files are untouched.`;
}

/** Drop a session whose request outgrew the model's per-minute limit and explain why. */
function rotateOverflowedSession(entry: AgentRunEntry, message: string): string {
  entry.flags.contextOverflow = true;
  entry.flags.sessionReset = true;
  if (entry.record.folder !== "") clearStoredSessionId(entry.record.folder);
  const translated = contextQuotaMessage(message, entry.record.contextTokens);
  entry.flags.lastError = translated;
  return translated;
}

/** Apply one output line to a run: keep the session id, the cost and the transcript. */
function handleLine(entry: AgentRunEntry, line: string): void {
  const result = parseAgentLine(line, entry.record.costMicros);
  if (result.sessionId !== null && !entry.flags.sessionReset) {
    entry.record.sessionId = result.sessionId;
    if (entry.record.folder !== "") storeSessionId(entry.record.folder, result.sessionId);
  }

  if (result.contextTokens !== undefined) {
    entry.record.contextTokens = result.contextTokens;
    entry.flags.contextTokens = result.contextTokens;
    if (!entry.flags.sessionReset) {
      rememberContextTokens(entry.record.folder, result.contextTokens);
    }
    emit(entry, { type: "context", tokens: result.contextTokens });
  }

  const event = result.event;
  if (event === null) return;
  if (event.type === "cost") entry.record.costMicros = event.micros;
  if (event.type === "error") entry.flags.lastError = event.message;
  if (result.modelError !== null && event.type === "error") {
    if (isContextQuotaError(result.modelError.type, event.message)) {
      // The session's context outgrew the model's per-minute limit: drop it so the next run
      // starts fresh (project files are untouched), and rewrite the chat-visible error.
      event.message = rotateOverflowedSession(entry, event.message);
    } else {
      // Only a model-wide limit blocks the model. A quota error with no retry window is more
      // often this request or this key, so it is reported without greying the model out.
      const retryAfterMs = result.modelError.retryAfterMs;
      if (retryAfterMs !== null || result.modelError.type !== "provider.quota") {
        markModelUnavailable(
          entry.record.model,
          result.modelError.type,
          Date.now() + (retryAfterMs ?? 60 * 60 * 1000),
        );
      }
    }
  }
  emit(entry, event);
}

/** One run's full state, for a browser that connects mid-turn. */
export function getAgentRun(runId: string): AgentRunDetail | null {
  reconcileAgentRuns();
  const entry = runs.get(runId);
  return entry === undefined ? null : publicDetail(entry);
}

/** The newest run for a project (or for the workspace chat when project is null). */
export function latestAgentRun(project: string | null): AgentRunDetail | null {
  reconcileAgentRuns();
  const wanted = project ?? "__workspace__";
  const matches = [...runs.values()].filter(
    (entry) => (entry.record.project ?? "__workspace__") === wanted,
  );
  matches.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
  const newest = matches[0];
  return newest === undefined ? null : publicDetail(newest);
}

/** Follow one run's events. Returns the unsubscribe function. */
export function subscribeAgentRun(
  runId: string,
  listener: (event: AgentEvent) => void,
): (() => void) | null {
  const entry = runs.get(runId);
  if (entry === undefined) return null;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Stop one run. Unknown or already finished runs are reported as they are. */
export function stopAgentRun(runId: string): AgentRunSummary {
  const entry = runs.get(runId);
  if (entry === undefined) throw new AgentRunError("run not found", 404);
  if (entry.record.status !== "running") return publicSummary(entry);

  entry.flags.stopped = true;
  if (entry.child === null) {
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    emit(entry, { type: "done", status: "cancelled", error: null });
    return publicSummary(entry);
  }

  killImpl(entry.child);

  // Safety net: a process that refuses to die must not leave the run "running" forever.
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.record.status !== "running") return;
    entry.record.status = "cancelled";
    entry.record.endedAt = new Date().toISOString();
    emit(entry, { type: "done", status: "cancelled", error: null });
  }, 5000);
  entry.timer.unref();

  return publicSummary(entry);
}

/** Forget a finished run so a fresh chat starts clean. */
export function forgetAgentRun(runId: string): void {
  const entry = runs.get(runId);
  if (entry === undefined) return;
  if (entry.record.status === "running") throw new AgentRunError("stop the run first", 409);
  runs.delete(runId);
}

// Cost is recorded by the same bookkeeping chat turns use, so spend caps see one number per model.
function recordSpend(model: string, micros: number): void {
  if (micros <= 0) return;
  recordChatSpend(model, micros);
}
