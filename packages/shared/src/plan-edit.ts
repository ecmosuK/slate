/**
 * Plan edits made by the in-app agent.
 *
 * The plan block belongs to the agent, so these helpers deliberately write only the values the
 * agent asked to change. They never touch the status or requests zones, and the caller always
 * writes the result back through `upsertZone`.
 */

import { PLAN_BUDGETS, type Plan, type PlanStatus, type PlanTask } from "./plan.ts";

export type PlanSection = "now" | "next" | "done";

export const PLAN_SECTION_LABELS: Record<PlanSection, string> = {
  now: "Now",
  next: "Next",
  done: "Done",
};

export interface PlanEdit {
  goal?: string;
  status?: PlanStatus;
  /** `null` or an empty string clears the milestone. */
  milestone?: string | null;
  agent?: string;
}

export interface CompleteTaskResult {
  plan: Plan;
  task: PlanTask | null;
  from: PlanSection | null;
}

function touch(plan: Plan, at: Date): Plan {
  return { ...plan, updated: at.toISOString() };
}

function cleanTask(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Apply the scalar parts of a plan: goal, status, milestone and the agent label. */
export function applyPlanEdit(plan: Plan, edit: PlanEdit, at: Date = new Date()): Plan {
  let next = touch(plan, at);

  if (edit.goal !== undefined) {
    next = { ...next, goal: edit.goal.trim() };
  }
  if (edit.status !== undefined) {
    next = { ...next, status: edit.status };
  }
  if (edit.milestone !== undefined) {
    const milestone = (edit.milestone ?? "").trim();
    next = { ...next, milestone: milestone === "" ? undefined : milestone };
  }
  if (edit.agent !== undefined && edit.agent.trim() !== "") {
    next = { ...next, agent: edit.agent.trim() };
  }

  return next;
}

/** Append tasks to one section, skipping duplicates already present in that section. */
export function addPlanTasks(
  plan: Plan,
  section: PlanSection,
  tasks: string[],
  at: Date = new Date(),
): Plan {
  const seen = new Set(plan[section].map((task) => task.text.toLowerCase()));
  const additions: PlanTask[] = [];

  for (const raw of tasks) {
    const text = cleanTask(raw);
    if (text === "") continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ text, done: section === "done" });
  }

  if (additions.length === 0) return plan;

  const next = { ...plan };
  next[section] = [...plan[section], ...additions];
  return touch(next, at);
}

function findTaskIndex(tasks: PlanTask[], query: string): number {
  const needle = cleanTask(query).toLowerCase();
  if (needle === "") return -1;

  let index = tasks.findIndex((task) => task.text.toLowerCase() === needle);
  if (index !== -1) return index;

  index = tasks.findIndex((task) => task.text.toLowerCase().includes(needle));
  if (index !== -1) return index;

  return tasks.findIndex((task) => needle.includes(task.text.toLowerCase()));
}

/**
 * Move a matching task from Now or Next into Done.
 *
 * Matching favours an exact title, then a substring in either direction, so "wire media_kit"
 * finds "Wire media_kit into the player service".
 */
export function completePlanTask(
  plan: Plan,
  query: string,
  at: Date = new Date(),
): CompleteTaskResult {
  for (const section of ["now", "next"] as const) {
    const index = findTaskIndex(plan[section], query);
    if (index === -1) continue;

    const task = plan[section][index];
    if (task === undefined) continue;

    const next = {
      ...plan,
      [section]: plan[section].filter((_, position) => position !== index),
      done: [...plan.done, { text: task.text, done: true }],
    };
    return { plan: touch(next, at), task, from: section };
  }

  const doneIndex = findTaskIndex(plan.done, query);
  if (doneIndex !== -1) {
    return { plan, task: plan.done[doneIndex] ?? null, from: "done" };
  }

  return { plan, task: null, from: null };
}

/** Append one dated log line, keeping the log inside its size budget. */
export function appendPlanLog(plan: Plan, message: string, at: Date = new Date()): Plan {
  const text = message.replace(/\s+/g, " ").trim().slice(0, 500);
  if (text === "") return plan;

  const date = at.toISOString().slice(0, 10);
  const log = [...plan.log, { date, text, raw: `${date} — ${text}` }];
  return touch({ ...plan, log: log.slice(-PLAN_BUDGETS.log) }, at);
}
