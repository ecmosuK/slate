import { describe, expect, it } from "vitest";

import {
  addPlanTasks,
  appendPlanLog,
  applyPlanEdit,
  completePlanTask,
  parsePlan,
  type Plan,
} from "@slate/shared";

const AT = new Date("2026-11-11T12:00:00Z");

function plan(): Plan {
  const result = parsePlan(
    [
      "<!-- slate:plan:begin project=demo version=1 -->",
      "---",
      "project: demo",
      "status: planning",
      "milestone: M0 — foundation",
      "agent: none",
      "updated: 2026-11-10T00:00:00Z",
      "---",
      "",
      "## Goal",
      "Ship a demo.",
      "",
      "## Now",
      "- [ ] Wire the API",
      "- [ ] Write the page",
      "",
      "## Next",
      "- [ ] Add tests",
      "",
      "## Done",
      "- [x] Scaffold the app",
      "",
      "## Log",
      "- 2026-11-10 — project created",
      "<!-- slate:plan:end -->",
    ].join("\n"),
  );
  if (!result.ok) throw new Error(result.detail);
  return result.plan;
}

describe("applyPlanEdit", () => {
  it("changes goal, status, milestone and agent", () => {
    const next = applyPlanEdit(
      plan(),
      {
        goal: "  Ship the real demo.  ",
        status: "in-progress",
        milestone: "M1 — first release",
        agent: "slate-agent",
      },
      AT,
    );

    expect(next.goal).toBe("Ship the real demo.");
    expect(next.status).toBe("in-progress");
    expect(next.milestone).toBe("M1 — first release");
    expect(next.agent).toBe("slate-agent");
    expect(next.updated).toBe(AT.toISOString());
    expect(next.now).toHaveLength(2);
  });

  it("clears the milestone with an empty string", () => {
    const next = applyPlanEdit(plan(), { milestone: "" }, AT);
    expect(next.milestone).toBeUndefined();
  });

  it("leaves fields alone when they are omitted", () => {
    const next = applyPlanEdit(plan(), { status: "blocked" }, AT);
    expect(next.goal).toBe("Ship a demo.");
    expect(next.milestone).toBe("M0 — foundation");
    expect(next.status).toBe("blocked");
  });
});

describe("addPlanTasks", () => {
  it("appends tasks and skips duplicates", () => {
    const next = addPlanTasks(plan(), "now", ["Wire the API", "  Check retries  "], AT);
    expect(next.now.map((task) => task.text)).toEqual([
      "Wire the API",
      "Write the page",
      "Check retries",
    ]);
    expect(next.updated).toBe(AT.toISOString());
  });

  it("marks tasks added to Done as complete", () => {
    const next = addPlanTasks(plan(), "done", ["Ship it"], AT);
    expect(next.done.at(-1)).toEqual({ text: "Ship it", done: true });
  });

  it("returns the plan unchanged when everything is a duplicate", () => {
    const original = plan();
    const next = addPlanTasks(original, "now", ["wire the api"], AT);
    expect(next).toBe(original);
  });
});

describe("completePlanTask", () => {
  it("moves a matching Now task into Done", () => {
    const result = completePlanTask(plan(), "wire the api", AT);
    expect(result.from).toBe("now");
    expect(result.task?.text).toBe("Wire the API");
    expect(result.plan.now.map((task) => task.text)).toEqual(["Write the page"]);
    expect(result.plan.done.at(-1)).toEqual({ text: "Wire the API", done: true });
  });

  it("matches a fragment of a task", () => {
    const result = completePlanTask(plan(), "tests", AT);
    expect(result.from).toBe("next");
    expect(result.task?.text).toBe("Add tests");
    expect(result.plan.next).toHaveLength(0);
  });

  it("reports a task that is already done without changing the plan", () => {
    const original = plan();
    const result = completePlanTask(original, "Scaffold the app", AT);
    expect(result.from).toBe("done");
    expect(result.plan).toBe(original);
  });

  it("returns no task when nothing matches", () => {
    const result = completePlanTask(plan(), "not a real task", AT);
    expect(result.from).toBeNull();
    expect(result.task).toBeNull();
  });
});

describe("appendPlanLog", () => {
  it("adds one dated line", () => {
    const next = appendPlanLog(plan(), "changed the milestone", AT);
    expect(next.log.at(-1)?.raw).toBe("2026-11-11 — changed the milestone");
    expect(next.updated).toBe(AT.toISOString());
  });

  it("keeps only the newest entries", () => {
    let current = plan();
    for (let index = 0; index < 20; index += 1) {
      current = appendPlanLog(current, `entry ${index}`, AT);
    }
    expect(current.log).toHaveLength(15);
    expect(current.log.at(-1)?.text).toBe("entry 19");
  });
});
