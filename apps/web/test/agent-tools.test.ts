import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePlan } from "@slate/shared";

import { executeAgentTool, type AgentToolContext } from "@/lib/agent-tools";
import { readGoals } from "@/lib/goals";

let root: string;
let context: AgentToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-agent-"));
  context = { root, agent: "test-agent" };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const outcome = await executeAgentTool(name, JSON.stringify(args), context);
  return {
    outcome,
    data: JSON.parse(outcome.content) as Record<string, unknown>,
  };
}

function readme(folder: string): string {
  return readFileSync(join(root, folder, "README.md"), "utf8");
}

function planOf(folder: string) {
  const result = parsePlan(readme(folder));
  if (!result.ok) throw new Error(result.detail);
  return result.plan;
}

async function createDemo(): Promise<string> {
  const { outcome, data } = await call("create_project", {
    name: "Recipe Vault",
    description: "A searchable box of family recipes.",
    goal: "Find any family recipe in seconds.",
    milestone: "M0 — shell",
    tasks: ["Write the schema", "Build the page"],
  });
  expect(outcome.ok).toBe(true);
  return data.project as string;
}

describe("create_project", () => {
  it("scaffolds a project with a plan, tasks and agent files", async () => {
    const slug = await createDemo();

    expect(slug).toBe("recipe-vault");
    expect(existsSync(join(root, slug, "AGENTS.md"))).toBe(true);

    const text = readme(slug);
    expect(text).toContain("# Recipe Vault");

    const plan = planOf(slug);
    expect(plan.project).toBe("recipe-vault");
    expect(plan.goal).toBe("Find any family recipe in seconds.");
    expect(plan.milestone).toBe("M0 — shell");
    expect(plan.agent).toBe("test-agent");
    expect(plan.status).toBe("planning");
    expect(plan.now.map((task) => task.text)).toEqual(["Write the schema", "Build the page"]);
    expect(plan.log.at(-1)?.text).toBe("project created from chat");
  });

  it("can be found by folder name or plan id", async () => {
    const slug = await createDemo();

    const byFolder = await call("read_project", { project: "Recipe Vault" });
    expect(byFolder.outcome.ok).toBe(true);
    expect((byFolder.data.project as string)).toBe(slug);

    const byPlanId = await call("read_project", { project: "recipe-vault" });
    expect(byPlanId.outcome.ok).toBe(true);
  });
});

describe("plan edits", () => {
  it("edits the goal, status and milestone", async () => {
    const slug = await createDemo();

    const { outcome } = await call("update_plan", {
      project: slug,
      goal: "Find any family recipe in two taps.",
      status: "in-progress",
      milestone: "M1 — first release",
    });
    expect(outcome.ok).toBe(true);

    const plan = planOf(slug);
    expect(plan.goal).toBe("Find any family recipe in two taps.");
    expect(plan.status).toBe("in-progress");
    expect(plan.milestone).toBe("M1 — first release");
    expect(plan.updated).not.toBe("2026-11-10T00:00:00Z");
  });

  it("clears a milestone", async () => {
    const slug = await createDemo();
    await call("update_plan", { project: slug, milestone: "" });
    expect(planOf(slug).milestone).toBeUndefined();
  });

  it("adds tasks and completes one into Done", async () => {
    const slug = await createDemo();

    await call("add_tasks", {
      project: slug,
      section: "next",
      tasks: ["Add the import flow"],
    });
    const completed = await call("complete_task", {
      project: slug,
      task: "write the schema",
    });
    expect(completed.outcome.ok).toBe(true);

    const plan = planOf(slug);
    expect(plan.now.map((task) => task.text)).toEqual(["Build the page"]);
    expect(plan.next.map((task) => task.text)).toEqual(["Add the import flow"]);
    expect(plan.done.at(-1)).toEqual({ text: "Write the schema", done: true });
    expect(plan.log.at(-1)?.text).toBe("completed: Write the schema");
  });

  it("reports an unknown task without changing the plan", async () => {
    const slug = await createDemo();
    const before = readme(slug);

    const { outcome } = await call("complete_task", {
      project: slug,
      task: "nothing like this",
    });

    expect(outcome.ok).toBe(false);
    expect(readme(slug)).toBe(before);
  });
});

describe("goals", () => {
  it("adds a goal, then completes it by id", async () => {
    const slug = await createDemo();

    const added = await call("add_goal", {
      project: slug,
      title: "Ship the first version",
      description: "A build the family can use.",
    });
    expect(added.outcome.ok).toBe(true);
    const goal = added.data.goal as { id: string; status: string };
    expect(goal.status).toBe("pending");

    const updated = await call("update_goal", {
      project: slug,
      id: goal.id,
      status: "done",
    });
    expect(updated.outcome.ok).toBe(true);

    const goals = readGoals(join(root, slug));
    expect(goals).toHaveLength(1);
    expect(goals[0]?.status).toBe("done");
  });

  it("updates a goal by title fragment", async () => {
    const slug = await createDemo();
    await call("add_goal", { project: slug, title: "Ship the first version" });

    const updated = await call("update_goal", {
      project: slug,
      match: "first version",
      title: "Ship version one",
    });
    expect(updated.outcome.ok).toBe(true);
    expect(readGoals(join(root, slug))[0]?.title).toBe("Ship version one");
  });

  it("refuses an update without an id or match", async () => {
    const slug = await createDemo();
    const { outcome } = await call("update_goal", { project: slug, status: "done" });
    expect(outcome.ok).toBe(false);
  });
});

describe("listing", () => {
  it("lists the projects in the root", async () => {
    const slug = await createDemo();
    const { outcome, data } = await call("list_projects", {});
    expect(outcome.ok).toBe(true);
    const projects = data.projects as { folder: string }[];
    expect(projects.map((project) => project.folder)).toContain(slug);
  });
});
