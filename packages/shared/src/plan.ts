/**
 * The agent plan block.
 *
 * The plan is written by the agent, read by Slate, and never written by Slate. Its shape is
 * deliberately rigid so that both sides can rely on it: YAML frontmatter for typed fields and
 * fixed `Goal / Now / Next / Done / Log` headings for the human-readable part.
 *
 * See `Free App Builds\03 Notion Clone\SPEC.md` §7 for the normative description.
 */

import { z } from "zod";
import { findZone, scanZones, type ZoneBlock } from "./zones.ts";

export const PLAN_STATUSES = ["planning", "in-progress", "blocked", "paused", "done"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_VERSION = "1";

export interface PlanTask {
  text: string;
  done: boolean;
}

export interface PlanLogEntry {
  date: string | null;
  text: string;
  raw: string;
}

export interface Plan {
  project: string;
  status: PlanStatus;
  milestone: string | undefined;
  agent: string;
  updated: string;
  goal: string;
  now: PlanTask[];
  next: PlanTask[];
  done: PlanTask[];
  log: PlanLogEntry[];
}

export type PlanParseResult =
  | { ok: true; plan: Plan; warnings: string[] }
  | { ok: false; reason: "missing" | "malformed" | "unsupported-version"; detail: string };

export const PLAN_BUDGETS = {
  now: 7,
  next: 10,
  done: 15,
  log: 15,
  bytes: 8 * 1024,
} as const;

const frontmatterSchema = z.object({
  project: z.string().min(1, "project is required"),
  status: z.enum(PLAN_STATUSES, {
    errorMap: () => ({ message: `status must be one of ${PLAN_STATUSES.join(", ")}` }),
  }),
  milestone: z.string().optional(),
  agent: z.string().min(1, "agent is required"),
  updated: z.string().min(1, "updated is required"),
});

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const LOG_LINE = /^\s*[-*]\s+(.*)$/;
const LOG_DATE = /^(\d{4}-\d{2}-\d{2})\s*[—–-]?\s*(.*)$/;

function stripInlineComment(value: string): string {
  const match = /\s#/.exec(value);
  return (match === null ? value : value.slice(0, match.index)).trim();
}

/** Parse flat `key: value` frontmatter. Values are strings; lists are not supported. */
export function parseFrontmatter(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = stripInlineComment(trimmed.slice(separator + 1));
    if (key !== "" && !(key in fields)) fields[key] = value;
  }
  return fields;
}

function splitFrontmatter(body: string): { frontmatter: string | null; rest: string } {
  const lines = body.split(/\r\n|\n|\r/);
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  if ((lines[index] ?? "").trim() !== "---") return { frontmatter: null, rest: body };

  const end = lines.findIndex((line, position) => position > index && line.trim() === "---");
  if (end === -1) return { frontmatter: null, rest: body };

  return {
    frontmatter: lines.slice(index + 1, end).join("\n"),
    rest: lines.slice(end + 1).join("\n"),
  };
}

function splitSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let heading = "";
  let buffer: string[] = [];
  const flush = () => {
    const key = heading.trim().toLowerCase();
    if (key !== "" && !sections.has(key)) sections.set(key, buffer);
  };
  for (const line of body.split(/\r\n|\n|\r/)) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match !== null) {
      flush();
      heading = match[1] ?? "";
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function readTasks(lines: string[] | undefined): PlanTask[] {
  const tasks: PlanTask[] = [];
  for (const line of lines ?? []) {
    const match = TASK_LINE.exec(line);
    if (match === null) continue;
    const text = (match[2] ?? "").trim();
    if (text === "") continue;
    tasks.push({ text, done: (match[1] ?? " ").toLowerCase() === "x" });
  }
  return tasks;
}

function readLog(lines: string[] | undefined): PlanLogEntry[] {
  const entries: PlanLogEntry[] = [];
  for (const line of lines ?? []) {
    const match = LOG_LINE.exec(line);
    if (match === null) continue;
    const raw = (match[1] ?? "").trim();
    if (raw === "") continue;
    const dated = LOG_DATE.exec(raw);
    entries.push({
      date: dated === null ? null : (dated[1] ?? null),
      text: dated === null ? raw : (dated[2] ?? "").trim(),
      raw,
    });
  }
  return entries;
}

/** Parse the plan block out of a README. */
export function parsePlan(text: string): PlanParseResult {
  const block = findZone(text, "plan");
  if (block === undefined) {
    return { ok: false, reason: "missing", detail: "no slate:plan block found" };
  }
  return parsePlanBlock(block);
}

export function parsePlanBlock(block: ZoneBlock): PlanParseResult {
  const version = block.attrs["version"];
  if (version !== undefined && version !== PLAN_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      detail: `plan version ${version} is not supported (expected ${PLAN_VERSION})`,
    };
  }

  const { frontmatter, rest } = splitFrontmatter(block.body);
  if (frontmatter === null) {
    return { ok: false, reason: "malformed", detail: "plan block has no frontmatter" };
  }

  const fields = parseFrontmatter(frontmatter);
  const parsed = frontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    return { ok: false, reason: "malformed", detail };
  }

  const sections = splitSections(rest);
  const goal = (sections.get("goal") ?? [])
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

  const plan: Plan = {
    project: parsed.data.project,
    status: parsed.data.status,
    milestone: parsed.data.milestone,
    agent: parsed.data.agent,
    updated: parsed.data.updated,
    goal,
    now: readTasks(sections.get("now")),
    next: readTasks(sections.get("next")),
    done: readTasks(sections.get("done")),
    log: readLog(sections.get("log")),
  };

  const warnings: string[] = [];
  if (version === undefined) warnings.push("plan block has no version attribute");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(plan.updated)) {
    warnings.push("updated is not an ISO-8601 timestamp");
  }
  if (plan.now.length > PLAN_BUDGETS.now) {
    warnings.push(`## Now has ${plan.now.length} items, over the limit of ${PLAN_BUDGETS.now}`);
  }
  if (plan.next.length > PLAN_BUDGETS.next) {
    warnings.push(`## Next has ${plan.next.length} items, over the limit of ${PLAN_BUDGETS.next}`);
  }
  if (plan.done.length > PLAN_BUDGETS.done) {
    warnings.push(`## Done has ${plan.done.length} items, over the limit of ${PLAN_BUDGETS.done}`);
  }
  if (plan.log.length > PLAN_BUDGETS.log) {
    warnings.push(`## Log has ${plan.log.length} entries, over the limit of ${PLAN_BUDGETS.log}`);
  }
  if (block.raw.length > PLAN_BUDGETS.bytes) {
    warnings.push(`plan block is ${block.raw.length} bytes, over ${PLAN_BUDGETS.bytes}`);
  }

  return { ok: true, plan, warnings };
}

export type Staleness = "fresh" | "aging" | "stale";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fresh under 7 days, aging under 30, stale after that. */
export function staleness(updated: string, now: Date = new Date()): Staleness {
  const timestamp = Date.parse(updated);
  if (Number.isNaN(timestamp)) return "stale";
  const age = now.getTime() - timestamp;
  if (age < 7 * DAY_MS) return "fresh";
  if (age < 30 * DAY_MS) return "aging";
  return "stale";
}

export interface PlanProgress {
  done: number;
  total: number;
}

/** Progress across the `## Now` list only. `## Next` is not work in flight. */
export function nowProgress(plan: Plan): PlanProgress {
  const total = plan.now.length;
  const done = plan.now.filter((task) => task.done).length;
  return { done, total };
}

/** Render a plan back to the block body, without the markers. */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`project: ${plan.project}`);
  lines.push(`status: ${plan.status}`);
  if (plan.milestone !== undefined && plan.milestone !== "") {
    lines.push(`milestone: ${plan.milestone}`);
  }
  lines.push(`agent: ${plan.agent}`);
  lines.push(`updated: ${plan.updated}`);
  lines.push("---");
  lines.push("");
  lines.push("## Goal");
  lines.push(plan.goal === "" ? "" : plan.goal);
  lines.push("");
  lines.push("## Now");
  for (const task of plan.now) lines.push(`- [${task.done ? "x" : " "}] ${task.text}`);
  lines.push("");
  lines.push("## Next");
  for (const task of plan.next) lines.push(`- [${task.done ? "x" : " "}] ${task.text}`);
  lines.push("");
  lines.push("## Done");
  for (const task of plan.done) lines.push(`- [${task.done ? "x" : " "}] ${task.text}`);
  lines.push("");
  lines.push("## Log");
  for (const entry of plan.log) lines.push(`- ${entry.raw}`);
  return lines.join("\n");
}

/** The template used when a project has no plan block yet. */
export function planTemplate(project: string, now = new Date()): string {
  return formatPlan({
    project,
    status: "planning",
    milestone: undefined,
    agent: "none",
    updated: now.toISOString(),
    goal: "One sentence: what this project is for and what done looks like.",
    now: [{ text: "Describe the first concrete task", done: false }],
    next: [],
    done: [],
    log: [],
  });
}

export interface Request {
  id: string;
  text: string;
  done: boolean;
}

const REQUEST_LINE = /^\s*[-*]\s+\[([ xX])\]\s*(#?[A-Za-z0-9_-]+)\s+(.*)$/;

/** Parse the requests block: `- [ ] #req3 add download retry`. */
export function parseRequests(text: string): Request[] {
  const block = findZone(text, "requests");
  if (block === undefined) return [];
  const requests: Request[] = [];
  for (const line of block.body.split(/\r\n|\n|\r/)) {
    const match = REQUEST_LINE.exec(line);
    if (match === null) continue;
    const id = match[2] ?? "";
    const body = (match[3] ?? "").trim();
    if (id === "") continue;
    requests.push({ id, text: body, done: (match[1] ?? " ").toLowerCase() === "x" });
  }
  return requests;
}

/**
 * A request is satisfied when its id appears in the plan log. The agent never edits the requests
 * block, so this is how a completed request gets ticked without two writers on one zone.
 */
export function resolveRequests(requests: Request[], plan: Plan): Request[] {
  const log = plan.log.map((entry) => entry.raw).join("\n");
  return requests.map((request) => {
    const token = request.id.replace(/^#/, "");
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])#?${token}([^A-Za-z0-9_-]|$)`, "m");
    return pattern.test(log) ? { ...request, done: true } : request;
  });
}

/** Convenience: parse requests and resolve them against the plan in one call. */
export function planWithRequests(text: string): { requests: Request[]; plan: Plan | null } {
  const parsed = parsePlan(text);
  const requests = parseRequests(text);
  if (!parsed.ok) return { requests, plan: null };
  return { requests: resolveRequests(requests, parsed.plan), plan: parsed.plan };
}

/** True when the document has more than one block for any zone. */
export function hasDuplicateZones(text: string): boolean {
  return scanZones(text).duplicates.length > 0;
}
