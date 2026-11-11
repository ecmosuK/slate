/**
 * The tools Slate's chat agent can call.
 *
 * The agent may create projects, edit the agent-owned plan block in a README, and add or update
 * goals. Everything else stays read-only: there is no tool that writes an arbitrary path.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  PLAN_SECTION_LABELS,
  PLAN_STATUSES,
  addPlanTasks,
  appendPlanLog,
  applyPlanEdit,
  completePlanTask,
  formatPlan,
  listProjects,
  parsePlan,
  planTemplate,
  scaffoldProject,
  slugify,
  upsertZone,
  type ChatTool,
  type Plan,
  type PlanSection,
  type PlanStatus,
} from "@slate/shared";

import { createGoal, readGoals, updateGoal } from "@/lib/goals";

export interface AgentToolContext {
  /** Absolute path to the projects root. */
  root: string;
  /** Value written to the plan's `agent:` field. */
  agent: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** JSON returned to the model as the tool result. */
  content: string;
  /** One short line shown in the chat transcript. */
  summary: string;
}

export const AGENT_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "list_projects",
      description:
        "List every project in the Slate projects root with its folder name, plan id, status, milestone and task progress.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_project",
      description:
        "Read one project's plan (goal, status, milestone, Now/Next/Done tasks, recent log) and its goals. Use this before editing a project other than the one already in context.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project folder name (for example '03 Notion Clone') or plan id.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description:
        "Create a new project folder with a README plan block, AGENTS.md and pointer files. Returns the folder name to use in later tool calls.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Human-readable project name; the folder is slugged from it.",
          },
          description: { type: "string", description: "One-line description for the README." },
          goal: {
            type: "string",
            description: "The plan goal. Defaults to the description when omitted.",
          },
          milestone: {
            type: "string",
            description: "Optional initial milestone, for example 'M0 — foundation'.",
          },
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "Optional initial tasks for the Now section.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Edit a project's plan metadata: goal, status, milestone, and log. Only include the fields that should change. Pass an empty milestone string to clear it.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project folder name or plan id.",
          },
          goal: { type: "string", description: "New goal sentence for the project." },
          status: {
            type: "string",
            enum: [...PLAN_STATUSES],
            description: "Plan status.",
          },
          milestone: {
            type: "string",
            description: "New milestone. Empty string clears the milestone.",
          },
          log: {
            type: "string",
            description: "Optional log line; a sensible one is written automatically.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_tasks",
      description:
        "Append one or more tasks to a project's Now, Next or Done section. Keep Now to at most seven open tasks.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project folder name or plan id." },
          section: {
            type: "string",
            enum: ["now", "next", "done"],
            description: "Plan section to append to.",
          },
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "Task texts, shortest useful phrasing.",
          },
        },
        required: ["project", "section", "tasks"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description:
        "Mark one task as done by moving it from Now or Next into Done. Accepts an exact task or a distinctive fragment.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project folder name or plan id." },
          task: {
            type: "string",
            description: "Task text or a distinctive fragment of it.",
          },
        },
        required: ["project", "task"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_goal",
      description:
        "Add a goal to a project's goals.json checklist. Goals are the user-facing outcomes; plan tasks are the work.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project folder name or plan id." },
          title: { type: "string", description: "What done looks like, in one line." },
          description: { type: "string", description: "Optional detail." },
        },
        required: ["project", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description:
        "Edit or complete an existing goal. Identify it by id (preferred) or by a case-insensitive title fragment.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project folder name or plan id." },
          id: { type: "string", description: "Goal id from read_project." },
          match: {
            type: "string",
            description: "Title fragment, used when the id is not known.",
          },
          title: { type: "string", description: "Replacement title." },
          description: { type: "string", description: "Replacement description." },
          status: {
            type: "string",
            enum: ["pending", "done"],
            description: "Mark the goal pending or done.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
];

class ToolError extends Error {}

interface ResolvedProject {
  slug: string;
  folder: string;
  planId: string;
  title: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function resolveProject(root: string, reference: unknown): ResolvedProject {
  const wanted = text(reference);
  if (wanted === "") throw new ToolError("a project is required");

  const entries = listProjects(root, { git: false });
  const lower = wanted.toLowerCase();
  const wantedSlug = slugify(wanted);

  const entry =
    entries.find((candidate) => basename(candidate.folder).toLowerCase() === lower) ??
    entries.find((candidate) => (candidate.plan?.project ?? "").toLowerCase() === lower) ??
    (wantedSlug === ""
      ? undefined
      : entries.find((candidate) => slugify(basename(candidate.folder)) === wantedSlug));

  if (entry === undefined) {
    const available = entries.map((candidate) => basename(candidate.folder)).join(", ");
    throw new ToolError(
      `project "${wanted}" was not found${available === "" ? "" : `; available: ${available}`}`,
    );
  }

  const slug = basename(entry.folder);
  return {
    slug,
    folder: entry.folder,
    planId: entry.plan?.project ?? slugify(slug),
    title: entry.title,
  };
}

function readmePath(folder: string): string {
  return join(folder, "README.md");
}

interface LoadedPlan {
  text: string;
  plan: Plan;
}

/**
 * Read the plan, adding one in memory when the README has none. A malformed plan is never
 * overwritten, because that would hide a real authoring error.
 */
function loadPlan(project: ResolvedProject): LoadedPlan {
  const path = readmePath(project.folder);
  if (!existsSync(path)) throw new ToolError(`${project.slug} has no README.md`);

  let text = readFileSync(path, "utf8");
  let parsed = parsePlan(text);

  if (!parsed.ok && parsed.reason === "missing") {
    text = upsertZone(text, "plan", planTemplate(project.planId), {
      project: project.planId,
      version: "1",
    }).text;
    parsed = parsePlan(text);
  }

  if (!parsed.ok) {
    throw new ToolError(`the plan block is ${parsed.reason}: ${parsed.detail}`);
  }

  return { text, plan: parsed.plan };
}

function writePlan(project: ResolvedProject, loaded: LoadedPlan, plan: Plan): void {
  const result = upsertZone(loaded.text, "plan", formatPlan(plan), {
    project: plan.project,
    version: "1",
  });
  if (result.changed) writeFileSync(readmePath(project.folder), result.text, "utf8");
}

function planView(plan: Plan): Record<string, unknown> {
  return {
    project: plan.project,
    status: plan.status,
    milestone: plan.milestone ?? null,
    goal: plan.goal,
    now: plan.now,
    next: plan.next,
    done: plan.done,
    log: plan.log.slice(-8).map((entry) => entry.raw),
  };
}

function success(summary: string, data: Record<string, unknown> = {}): ToolOutcome {
  return {
    ok: true,
    summary,
    content: JSON.stringify({ ok: true, ...data }, null, 2),
  };
}

function failure(message: string): ToolOutcome {
  return {
    ok: false,
    summary: `Failed: ${message}`,
    content: JSON.stringify({ ok: false, error: message }, null, 2),
  };
}

function listProjectsTool(context: AgentToolContext): ToolOutcome {
  const entries = listProjects(context.root, { git: false });
  const projects = entries.map((entry) => ({
    folder: basename(entry.folder),
    planId: entry.plan?.project ?? null,
    title: entry.title,
    status: entry.status,
    milestone: entry.milestone,
    tasks: entry.tasks,
    goal: entry.goal,
  }));
  return success(`${projects.length} project(s) listed`, { projects });
}

function readProjectTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  const path = readmePath(project.folder);
  const parsed = existsSync(path) ? parsePlan(readFileSync(path, "utf8")) : null;

  let goals: unknown[] = [];
  let goalsError: string | null = null;
  try {
    goals = readGoals(project.folder).map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: goal.status,
    }));
  } catch (error) {
    goalsError = error instanceof Error ? error.message : String(error);
  }

  return success(`Read ${project.slug}`, {
    project: project.slug,
    planId: parsed?.ok === true ? parsed.plan.project : project.planId,
    title: project.title,
    plan: parsed?.ok === true ? planView(parsed.plan) : null,
    planProblem: parsed !== null && !parsed.ok ? `${parsed.reason}: ${parsed.detail}` : null,
    goals,
    goalsError,
  });
}

function createProjectTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const name = text(args.name).replace(/\s+/g, " ");
  if (name === "") throw new ToolError("a project name is required");

  const description = text(args.description);
  const goal = text(args.goal);
  const milestone = text(args.milestone);
  const tasks = textList(args.tasks);

  const scaffold = scaffoldProject(context.root, {
    name,
    description: description === "" ? goal : description,
  });
  const project: ResolvedProject = {
    slug: scaffold.slug,
    folder: scaffold.folder,
    planId: scaffold.slug,
    title: name,
  };

  const loaded = loadPlan(project);
  let plan = applyPlanEdit(loaded.plan, {
    agent: context.agent,
    status: "planning",
    goal: goal !== "" ? goal : description !== "" ? description : undefined,
    milestone: milestone === "" ? undefined : milestone,
  });

  if (tasks.length > 0) {
    plan = addPlanTasks({ ...plan, now: [] }, "now", tasks);
  }

  plan = appendPlanLog(plan, "project created from chat");
  writePlan(project, loaded, plan);

  // The scaffold names the page after the slug; the agent usually has a nicer name.
  if (name !== scaffold.slug) {
    const path = readmePath(scaffold.folder);
    const lines = readFileSync(path, "utf8").split(/\r\n|\n/);
    const heading = `# ${scaffold.slug}`;
    const index = lines.findIndex((line) => line.trim() === heading);
    if (index !== -1) {
      lines[index] = `# ${name}`;
      writeFileSync(path, lines.join("\n"), "utf8");
    }
  }

  return success(`Created ${scaffold.slug}`, {
    project: scaffold.slug,
    planId: plan.project,
    folder: scaffold.folder,
    created: scaffold.created,
    plan: planView(plan),
  });
}

function updatePlanTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  const loaded = loadPlan(project);

  const goal = args.goal === undefined ? undefined : text(args.goal);
  const milestone = args.milestone === undefined ? undefined : text(args.milestone);
  const status = args.status === undefined ? undefined : text(args.status);

  if (status !== undefined && !(PLAN_STATUSES as readonly string[]).includes(status)) {
    throw new ToolError(`status must be one of ${PLAN_STATUSES.join(", ")}`);
  }
  if (goal === undefined && milestone === undefined && status === undefined) {
    throw new ToolError("nothing to change; supply goal, status or milestone");
  }

  const changed: string[] = [];
  if (goal !== undefined) changed.push("goal");
  if (milestone !== undefined) changed.push("milestone");
  if (status !== undefined) changed.push("status");

  let plan = applyPlanEdit(loaded.plan, {
    agent: context.agent,
    goal,
    milestone,
    status: status as PlanStatus | undefined,
  });
  plan = appendPlanLog(plan, text(args.log) || `plan updated: ${changed.join(", ")}`);
  writePlan(project, loaded, plan);

  return success(`Updated ${project.slug}: ${changed.join(", ")}`, {
    project: project.slug,
    plan: planView(plan),
  });
}

function addTasksTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  const rawSection = text(args.section);
  if (rawSection !== "now" && rawSection !== "next" && rawSection !== "done") {
    throw new ToolError("section must be now, next or done");
  }
  const section: PlanSection = rawSection;

  const tasks = textList(args.tasks);
  if (tasks.length === 0) throw new ToolError("at least one task is required");

  const loaded = loadPlan(project);
  const before = loaded.plan[section].length;
  let plan = addPlanTasks(loaded.plan, section, tasks);
  const added = plan[section].length - before;

  if (added === 0) {
    return success(`No new tasks for ${PLAN_SECTION_LABELS[section]} in ${project.slug}`, {
      project: project.slug,
      plan: planView(plan),
    });
  }

  plan = appendPlanLog(
    plan,
    `added ${added} task(s) to ${PLAN_SECTION_LABELS[section]}`,
  );
  writePlan(project, loaded, plan);

  return success(
    `Added ${added} task(s) to ${PLAN_SECTION_LABELS[section]} in ${project.slug}`,
    { project: project.slug, plan: planView(plan) },
  );
}

function completeTaskTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  const query = text(args.task);
  if (query === "") throw new ToolError("a task is required");

  const loaded = loadPlan(project);
  const result = completePlanTask(loaded.plan, query);

  if (result.task === null) {
    const open = [...loaded.plan.now, ...loaded.plan.next]
      .filter((task) => !task.done)
      .map((task) => `- ${task.text}`)
      .join("\n");
    throw new ToolError(
      `no task matched "${query}"${open === "" ? "" : `; open tasks:\n${open}`}`,
    );
  }

  if (result.from === "done") {
    return success(`"${result.task.text}" is already done in ${project.slug}`, {
      project: project.slug,
      plan: planView(loaded.plan),
    });
  }

  const plan = appendPlanLog(result.plan, `completed: ${result.task.text}`);
  writePlan(project, loaded, plan);

  return success(`Completed "${result.task.text}" in ${project.slug}`, {
    project: project.slug,
    plan: planView(plan),
  });
}

function addGoalTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  const goal = createGoal(project.folder, {
    title: args.title,
    description: args.description,
  });

  return success(`Added goal "${goal.title}" to ${project.slug}`, {
    project: project.slug,
    goal,
    goals: readGoals(project.folder),
  });
}

function updateGoalTool(context: AgentToolContext, args: Record<string, unknown>): ToolOutcome {
  const project = resolveProject(context.root, args.project);
  if (
    args.title === undefined &&
    args.description === undefined &&
    args.status === undefined
  ) {
    throw new ToolError("nothing to change; supply title, description or status");
  }
  if (
    args.status !== undefined &&
    args.status !== "pending" &&
    args.status !== "done"
  ) {
    throw new ToolError("status must be pending or done");
  }

  const goal = updateGoal(project.folder, {
    id: args.id,
    match: args.match,
    title: args.title,
    description: args.description,
    status: args.status,
  });

  return success(`Updated goal "${goal.title}" in ${project.slug}`, {
    project: project.slug,
    goal,
    goals: readGoals(project.folder),
  });
}

export async function executeAgentTool(
  name: string,
  rawArguments: string,
  context: AgentToolContext,
): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};

  if (rawArguments.trim() !== "") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("arguments must be a JSON object");
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`invalid tool arguments: ${message}`);
    }
  }

  try {
    switch (name) {
      case "list_projects":
        return listProjectsTool(context);
      case "read_project":
        return readProjectTool(context, args);
      case "create_project":
        return createProjectTool(context, args);
      case "update_plan":
        return updatePlanTool(context, args);
      case "add_tasks":
        return addTasksTool(context, args);
      case "complete_task":
        return completeTaskTool(context, args);
      case "add_goal":
        return addGoalTool(context, args);
      case "update_goal":
        return updateGoalTool(context, args);
      default:
        return failure(`unknown tool "${name}"`);
    }
  } catch (error) {
    if (error instanceof ToolError) return failure(error.message);
    return failure(error instanceof Error ? error.message : String(error));
  }
}
