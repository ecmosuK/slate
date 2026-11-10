import { describe, expect, it } from "vitest";

import { summarizePortfolio, summarizeReadme } from "@slate/shared";

const WITH_PLAN = [
  "# 01 Music Player",
  "",
  "A player for the home server.",
  "",
  "<!-- slate:plan:begin project=01-music-player version=1 -->",
  "---",
  "project: 01-music-player",
  "status: in-progress",
  "milestone: M2 — playback",
  "agent: opencode/test",
  "updated: 2026-11-10T14:03:00Z",
  "---",
  "",
  "## Goal",
  "Ship a Spotify-shaped client.",
  "",
  "## Now",
  "- [ ] Wire media_kit into the player service",
  "- [x] Persist queue state",
  "",
  "## Done",
  "- [x] Subsonic auth",
  "<!-- slate:plan:end -->",
  "",
].join("\n");

const PLAIN = [
  "# Budget tracker",
  "",
  "![build](https://example.com/badge.svg)",
  "",
  "Tracks household spending so I can see what is left before the month ends.",
  "",
  "**Status:** in progress",
  "**Next milestone:** import CSV statements",
  "",
  "## Next",
  "- write the CSV importer",
  "- add a spending report",
  "",
  "## Progress",
  "- [x] set up the database",
  "- [x] add the accounts table",
  "- [ ] build the dashboard",
  "",
].join("\n");

describe("summarizeReadme", () => {
  it("reads a structured plan", () => {
    const summary = summarizeReadme(WITH_PLAN, { slug: "01-music-player" });
    expect(summary.source).toBe("plan");
    expect(summary.title).toBe("01 Music Player");
    expect(summary.status).toBe("in-progress");
    expect(summary.milestone).toBe("M2 — playback");
    expect(summary.goal).toBe("Ship a Spotify-shaped client.");
    expect(summary.tasks).toEqual({ done: 2, total: 3 });
    expect(summary.plan?.agent).toBe("opencode/test");
  });

  it("reads an ordinary readme without any protocol", () => {
    const summary = summarizeReadme(PLAIN, { slug: "budget-tracker" });
    expect(summary.source).toBe("heuristic");
    expect(summary.title).toBe("Budget tracker");
    expect(summary.status).toBe("in progress");
    expect(summary.milestone).toBe("import CSV statements");
    expect(summary.goal).toBe(
      "Tracks household spending so I can see what is left before the month ends.",
    );
    expect(summary.tasks).toEqual({ done: 2, total: 3 });
    expect(summary.nextSteps).toEqual([
      "write the CSV importer",
      "add a spending report",
    ]);
  });

  it("reports an empty readme as empty", () => {
    const summary = summarizeReadme("", { slug: "nothing" });
    expect(summary.source).toBe("empty");
    expect(summary.tasks).toEqual({ done: 0, total: 0 });
    expect(summary.title).toBeNull();
  });

  it("ignores checkboxes inside fenced code", () => {
    const text = ["# Doc", "", "```md", "- [ ] not a real task", "```", ""].join("\n");
    const summary = summarizeReadme(text, { slug: "doc" });
    expect(summary.tasks).toEqual({ done: 0, total: 0 });
  });

  it("flags a malformed plan block but still summarises the rest", () => {
    const broken = WITH_PLAN.replace("status: in-progress", "status: almost");
    const summary = summarizeReadme(broken, { slug: "01-music-player" });
    expect(summary.warnings.join(" ")).toContain("malformed");
    expect(summary.tasks.total).toBe(3);
  });

  it("lists the headings", () => {
    const summary = summarizeReadme(PLAIN, { slug: "budget-tracker" });
    expect(summary.sections).toEqual(["Budget tracker", "Next", "Progress"]);
  });
});

describe("summarizePortfolio", () => {
  it("rolls projects up into one picture", () => {
    const portfolio = summarizePortfolio([
      summarizeReadme(WITH_PLAN, { slug: "a" }),
      summarizeReadme(PLAIN, { slug: "b" }),
      summarizeReadme("", { slug: "c" }),
    ]);
    expect(portfolio.projects).toBe(3);
    expect(portfolio.withPlan).toBe(1);
    expect(portfolio.empty).toBe(1);
    expect(portfolio.tasksDone).toBe(4);
    expect(portfolio.tasksTotal).toBe(6);
  });
});
