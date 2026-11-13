/**
 * Goals are Slate's own per-project checklist (`goals.json`), separate from the agent-owned
 * README plan. The web API and the chat tools share this one implementation so both write the
 * same shape.
 *
 * A goal carries a priority (high, medium, low) and an order. The order is the position of the
 * goal in the file: goals read top to bottom are meant to be done in that order, so "do this,
 * then this, then this" survives a round trip through disk.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GoalStatus = "pending" | "done";
export type GoalPriority = "high" | "medium" | "low";

export const GOAL_PRIORITIES: GoalPriority[] = ["high", "medium", "low"];

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  /** When the goal is scheduled (empty string means unscheduled). */
  dueAt?: string;
  /** Task texts this goal produced, in the order they were added. */
  tasks: string[];
  createdAt: string;
  updatedAt: string;
}

/** Where a goal moves when its order changes. */
export type GoalMove = "up" | "down" | "top" | "bottom";

export class GoalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GoalError";
    this.status = status;
  }
}

export function goalsPath(folder: string): string {
  return join(folder, "goals.json");
}

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function priorityOf(value: unknown): GoalPriority {
  return value === "high" || value === "low" || value === "medium" ? value : "medium";
}

/** Read goals.json, tolerating the two shapes this app has written. */
export function readGoals(folder: string): Goal[] {
  const path = goalsPath(folder);
  if (!existsSync(path)) return [];

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { goals?: unknown }).goals)
      ? (parsed as { goals: unknown[] }).goals
      : [];

  const goals: Goal[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string") continue;
    goals.push({
      id: row.id,
      title: row.title,
      description: typeof row.description === "string" ? row.description : "",
      status: row.status === "done" ? "done" : "pending",
      priority: priorityOf(row.priority),
      dueAt: typeof row.dueAt === "string" ? row.dueAt : "",
      tasks: Array.isArray(row.tasks)
        ? row.tasks.filter((entry): entry is string => typeof entry === "string")
        : [],
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    });
  }
  return goals;
}

export function writeGoals(folder: string, goals: Goal[]): void {
  const path = goalsPath(folder);
  const text = `${JSON.stringify({ goals }, null, 2)}\n`;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, "utf8");
  try {
    renameSync(temporary, path);
  } catch {
    // Some Windows filesystems refuse to replace an existing file with rename.
    writeFileSync(path, text, "utf8");
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is harmless.
    }
  }
}

export interface CreateGoalInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  /** Index to insert the goal at. Missing means "append at the end". */
  position?: unknown;
}

export function createGoal(folder: string, input: CreateGoalInput): Goal {
  const title = clean(input.title, 200);
  if (title === "") throw new GoalError("a goal title is required", 400);

  const now = new Date().toISOString();
  const goal: Goal = {
    id: randomUUID(),
    title,
    description: clean(input.description, 2000),
    status: "pending",
    priority: priorityOf(input.priority),
    dueAt: typeof input.dueAt === "string" ? input.dueAt : "",
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };

  const goals = readGoals(folder);
  const position =
    typeof input.position === "number" && Number.isFinite(input.position)
      ? Math.max(0, Math.min(Math.trunc(input.position), goals.length))
      : goals.length;
  goals.splice(position, 0, goal);
  writeGoals(folder, goals);
  return goal;
}

export interface GoalChanges {
  id?: unknown;
  /** Case-insensitive title fragment, used when the id is not known. */
  match?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  /** Move the goal up, down, to the top or to the bottom of the list. */
  move?: unknown;
}

/** Update one goal by id, or by title fragment. Throws GoalError when it cannot. */
export function updateGoal(folder: string, changes: GoalChanges): Goal {
  const id = clean(changes.id, 100);
  const match = clean(changes.match, 200);
  if (id === "" && match === "") {
    throw new GoalError("a goal id or title match is required", 400);
  }

  const goals = readGoals(folder);
  let index = id === "" ? -1 : goals.findIndex((goal) => goal.id === id);
  if (index === -1 && match !== "") {
    const needle = match.toLowerCase();
    index = goals.findIndex((goal) => goal.title.toLowerCase().includes(needle));
  }
  if (index === -1) throw new GoalError("goal not found", 404);

  const current = goals[index];
  if (current === undefined) throw new GoalError("goal not found", 404);

  const title =
    changes.title === undefined ? current.title : clean(changes.title, 200);
  if (title === "") throw new GoalError("a goal title is required", 400);

  const status: GoalStatus =
    changes.status === undefined
      ? current.status
      : changes.status === "done"
        ? "done"
        : "pending";

  const priority =
    changes.priority === undefined ? current.priority : priorityOf(changes.priority);

  const updated: Goal = {
    ...current,
    title,
    description:
      changes.description === undefined
        ? current.description
        : clean(changes.description, 2000),
    status,
    priority,
    dueAt:
      changes.dueAt === undefined
        ? (current.dueAt ?? "")
        : changes.dueAt === null || changes.dueAt === ""
          ? ""
          : String(changes.dueAt),
    updatedAt: new Date().toISOString(),
  };

  goals[index] = updated;

  const move = changes.move === undefined ? null : clean(changes.move, 20).toLowerCase();
  if (move !== null && move !== "") {
    if (move !== "up" && move !== "down" && move !== "top" && move !== "bottom") {
      throw new GoalError("move must be up, down, top or bottom", 400);
    }
    const [goal] = goals.splice(index, 1);
    if (goal === undefined) throw new GoalError("goal not found", 404);
    const target =
      move === "top"
        ? 0
        : move === "bottom"
          ? goals.length
          : move === "up"
            ? Math.max(0, index - 1)
            : Math.min(goals.length, index + 1);
    goals.splice(target, 0, goal);
  }

  writeGoals(folder, goals);
  return updated;
}

/**
 * Reorder the whole list from an explicit list of goal ids.
 *
 * Ids that are not named keep their relative order at the end of the list.
 */
export function reorderGoals(folder: string, ids: string[]): Goal[] {
  const goals = readGoals(folder);
  if (ids.length === 0) return goals;

  const remaining = [...goals];
  const arranged: Goal[] = [];
  for (const raw of ids) {
    const wanted = clean(raw, 100);
    if (wanted === "") continue;
    const index = remaining.findIndex((goal) => goal.id === wanted);
    if (index === -1) continue;
    const [taken] = remaining.splice(index, 1);
    if (taken !== undefined) arranged.push(taken);
  }

  const ordered = [...arranged, ...remaining];
  writeGoals(folder, ordered);
  return ordered;
}

/** Remove a goal by id and return the remaining list. */
export function deleteGoal(folder: string, id: string): Goal[] {
  const goals = readGoals(folder);
  const remaining = goals.filter((goal) => goal.id !== id);
  if (remaining.length === goals.length) throw new GoalError("goal not found", 404);
  writeGoals(folder, remaining);
  return remaining;
}

/** Lower rank means more important. */
export function priorityRank(priority: GoalPriority): number {
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  return 2;
}

/**
 * The goals in the order work should happen: by priority first, then by the order they read in
 * the list. Goals that are done come last, because they need no more work.
 */
export function goalsByPriority(goals: Goal[]): Goal[] {
  return [...goals].sort((left, right) => {
    if (left.status !== right.status) return left.status === "done" ? 1 : -1;
    const rank = priorityRank(left.priority) - priorityRank(right.priority);
    if (rank !== 0) return rank;
    return goals.indexOf(left) - goals.indexOf(right);
  });
}

/** Find one goal by id, or by a case-insensitive title fragment. */
export function findGoal(goals: Goal[], id: string, match: string): Goal | null {
  if (id !== "") {
    const found = goals.find((goal) => goal.id === id);
    if (found !== undefined) return found;
  }
  if (match !== "") {
    const needle = match.toLowerCase();
    const found = goals.find((goal) => goal.title.toLowerCase().includes(needle));
    if (found !== undefined) return found;
  }
  return null;
}

/** Record the task texts a goal produced, keeping the existing ones. */
export function attachGoalTasks(folder: string, goalId: string, tasks: string[]): void {
  const goals = readGoals(folder);
  const index = goals.findIndex((goal) => goal.id === goalId);
  if (index === -1) return;
  const current = goals[index];
  if (current === undefined) return;

  const known = new Set(current.tasks.map((task) => task.toLowerCase()));
  const additions = tasks.filter((task) => {
    const key = task.trim().toLowerCase();
    if (key === "" || known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (additions.length === 0) return;

  goals[index] = {
    ...current,
    tasks: [...current.tasks, ...additions],
    updatedAt: new Date().toISOString(),
  };
  writeGoals(folder, goals);
}

/**
 * Where a goal's tasks belong inside a plan section.
 *
 * Goals are worked in priority order, so the tasks of a higher-priority goal sit above the tasks
 * of a lower-priority one. The index counts from the top of the section.
 */
export function taskIndexForGoal(
  goals: Goal[],
  goalId: string,
  sectionTasks: { text: string }[],
): number {
  const ordered = goalsByPriority(goals);
  const target = ordered.findIndex((goal) => goal.id === goalId);
  if (target === -1) return sectionTasks.length;

  // The work of a more important goal stays above this goal's work.
  const earlier = new Set<string>();
  for (const goal of ordered.slice(0, target)) {
    for (const task of goal.tasks) earlier.add(task.toLowerCase());
  }
  // The work of a less important goal stays below this goal's work.
  const later = new Set<string>();
  for (const goal of ordered.slice(target + 1)) {
    for (const task of goal.tasks) later.add(task.toLowerCase());
  }

  // Land before the first task that belongs to a less important goal.
  const firstLater = sectionTasks.findIndex((task) => later.has(task.text.toLowerCase()));
  if (firstLater !== -1) return firstLater;

  // Otherwise, land after the last task that belongs to a more important goal.
  for (let position = sectionTasks.length - 1; position >= 0; position -= 1) {
    const task = sectionTasks[position];
    if (task === undefined) continue;
    if (earlier.has(task.text.toLowerCase())) return position + 1;
  }

  return sectionTasks.length;
}
