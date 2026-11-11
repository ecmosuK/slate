/**
 * Goals are Slate's own per-project checklist (`goals.json`), separate from the agent-owned
 * README plan. The web API and the chat tools share this one implementation so both write the
 * same shape.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GoalStatus = "pending" | "done";

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export class GoalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoalError";
  }
}

export function goalsPath(folder: string): string {
  return join(folder, "goals.json");
}

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
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

export function createGoal(
  folder: string,
  input: { title?: unknown; description?: unknown },
): Goal {
  const title = clean(input.title, 200);
  if (title === "") throw new GoalError("a goal title is required", 400);

  const now = new Date().toISOString();
  const goal: Goal = {
    id: randomUUID(),
    title,
    description: clean(input.description, 2000),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const goals = readGoals(folder);
  goals.push(goal);
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

  const updated: Goal = {
    ...current,
    title,
    description:
      changes.description === undefined
        ? current.description
        : clean(changes.description, 2000),
    status,
    updatedAt: new Date().toISOString(),
  };

  goals[index] = updated;
  writeGoals(folder, goals);
  return updated;
}

/** Remove a goal by id and return the remaining list. */
export function deleteGoal(folder: string, id: string): Goal[] {
  const goals = readGoals(folder);
  const remaining = goals.filter((goal) => goal.id !== id);
  if (remaining.length === goals.length) throw new GoalError("goal not found", 404);
  writeGoals(folder, remaining);
  return remaining;
}
