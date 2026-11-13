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

/**
 * Where a task should land inside a section.
 *
 * `index` counts from the top of the section; `top` and `bottom` are shorthands. Tasks added at an
 * index are inserted before the task that currently sits there.
 */
export type TaskPosition = number | "top" | "bottom";

/** Append tasks to one section at a given position, skipping duplicates. */
export function insertPlanTasks(
  plan: Plan,
  section: PlanSection,
  tasks: string[],
  position: TaskPosition,
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

  const current = plan[section];
  const index =
    position === "top"
      ? 0
      : position === "bottom"
        ? current.length
        : Math.max(0, Math.min(Math.trunc(position), current.length));

  const next = { ...plan };
  next[section] = [...current.slice(0, index), ...additions, ...current.slice(index)];
  return touch(next, at);
}

export interface MoveTaskTarget {
  /** Move up or down one place, to the top, or to the bottom of the section. */
  to?: "up" | "down" | "top" | "bottom";
  /** Place the task before this one. */
  before?: string;
  /** Place the task after this one. */
  after?: string;
}

/**
 * Move one task inside a section.
 *
 * Matching favours an exact title, then a substring in either direction, so "wire media_kit"
 * finds "Wire media_kit into the player service".
 */
export function movePlanTask(
  plan: Plan,
  section: PlanSection,
  query: string,
  target: MoveTaskTarget,
  at: Date = new Date(),
): { plan: Plan; task: PlanTask | null; moved: boolean } {
  const tasks = plan[section];
  const index = findTaskIndex(tasks, query);
  if (index === -1) return { plan, task: null, moved: false };

  const task = tasks[index];
  if (task === undefined) return { plan, task: null, moved: false };

  const rest = tasks.filter((_, position) => position !== index);

  let insertAt = index;
  if (target.to === "top") {
    insertAt = 0;
  } else if (target.to === "bottom") {
    insertAt = rest.length;
  } else if (target.to === "up") {
    insertAt = Math.max(0, index - 1);
  } else if (target.to === "down") {
    insertAt = Math.min(rest.length, index + 1);
  } else if (target.before !== undefined && target.before.trim() !== "") {
    const anchor = findTaskIndex(rest, target.before);
    insertAt = anchor === -1 ? rest.length : anchor;
  } else if (target.after !== undefined && target.after.trim() !== "") {
    const anchor = findTaskIndex(rest, target.after);
    insertAt = anchor === -1 ? rest.length : anchor + 1;
  } else {
    return { plan, task, moved: false };
  }

  const next = [...rest.slice(0, insertAt), task, ...rest.slice(insertAt)];
  return {
    plan: touch({ ...plan, [section]: next }, at),
    task,
    moved: true,
  };
}

/**
 * Reorder a whole section from an explicit list of task titles.
 *
 * Titles are matched exactly first, then as fragments; tasks that are not named keep their
 * relative order at the end of the section.
 */
export function reorderPlanTasks(
  plan: Plan,
  section: PlanSection,
  order: string[],
  at: Date = new Date(),
): { plan: Plan; ordered: string[]; unmatched: string[] } {
  const tasks = plan[section];
  if (tasks.length === 0 || order.length === 0) {
    return { plan, ordered: [], unmatched: order.map((text) => text.trim()).filter((t) => t !== "") };
  }

  const remaining = [...tasks];
  const arranged: PlanTask[] = [];
  const unmatched: string[] = [];

  for (const raw of order) {
    const wanted = cleanTask(raw);
    if (wanted === "") continue;
    const exact = remaining.findIndex(
      (task) => task.text.toLowerCase() === wanted.toLowerCase(),
    );
    const index =
      exact !== -1
        ? exact
        : remaining.findIndex((task) =>
            task.text.toLowerCase().includes(wanted.toLowerCase()) ||
            wanted.toLowerCase().includes(task.text.toLowerCase()),
          );
    if (index === -1) {
      unmatched.push(wanted);
      continue;
    }
    const [taken] = remaining.splice(index, 1);
    if (taken !== undefined) arranged.push(taken);
  }

  const ordered = [...arranged, ...remaining];
  const next = { ...plan };
  next[section] = ordered;
  return {
    plan: touch(next, at),
    ordered: ordered.map((task) => task.text),
    unmatched,
  };
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
 * Remove a task from a section entirely.
 *
 * Matching favours an exact title, then a substring in either direction, so "wire media_kit"
 * finds "Wire media_kit into the player service".
 */
export function removePlanTask(
  plan: Plan,
  section: PlanSection,
  query: string,
  at: Date = new Date(),
): CompleteTaskResult {
  const index = findTaskIndex(plan[section], query);
  if (index === -1) return { plan, task: null, from: null };

  const task = plan[section][index];
  if (task === undefined) return { plan, task: null, from: null };

  const next = {
    ...plan,
    [section]: plan[section].filter((_, position) => position !== index),
  };
  return { plan: touch(next, at), task, from: section };
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
