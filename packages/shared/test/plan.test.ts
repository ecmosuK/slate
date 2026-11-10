import { describe, expect, it } from "vitest";

import {
  formatPlan,
  nowProgress,
  parseFrontmatter,
  parsePlan,
  parseRequests,
  planTemplate,
  resolveRequests,
  staleness,
  type Plan,
} from "@slate/shared";

const README = [
  "# 01 Music Player",
  "",
  "<!-- slate:plan:begin project=01-music-player version=1 -->",
  "---",
  "project: 01-music-player",
  "status: in-progress        # planning | in-progress | blocked | paused | done",
  "milestone: M2 — playback",
  "agent: opencode/deepseek-v4",
  "updated: 2026-11-10T14:03:00Z",
  "---",
  "",
  "## Goal",
  "Ship a Spotify-shaped client against the home Navidrome server.",
  "",
  "## Now",
  "- [ ] Wire media_kit into the player service",
  "- [x] Persist queue state across restarts",
  "",
  "## Next",
  "- [ ] Downloads isolate with resumable ranges",
  "",
  "## Done",
  "- [x] Subsonic auth + library sync",
  "",
  "## Log",
  "- 2026-11-10 — scaffolded project, chose media_kit over just_audio",
  "<!-- slate:plan:end -->",
  "",
].join("\n");

describe("parseFrontmatter", () => {
  it("reads flat keys and drops inline comments", () => {
    expect(parseFrontmatter("status: in-progress   # a comment\nproject: x")).toEqual({
      status: "in-progress",
      project: "x",
    });
  });

  it("ignores lines without a separator", () => {
    expect(parseFrontmatter("nonsense")).toEqual({});
  });
});

describe("parsePlan", () => {
  it("parses frontmatter, sections and tasks", () => {
    const result = parsePlan(README);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = result.plan;
    expect(plan.project).toBe("01-music-player");
    expect(plan.status).toBe("in-progress");
    expect(plan.milestone).toBe("M2 — playback");
    expect(plan.agent).toBe("opencode/deepseek-v4");
    expect(plan.updated).toBe("2026-11-10T14:03:00Z");
    expect(plan.goal).toBe("Ship a Spotify-shaped client against the home Navidrome server.");
    expect(plan.now).toEqual([
      { text: "Wire media_kit into the player service", done: false },
      { text: "Persist queue state across restarts", done: true },
    ]);
    expect(plan.next).toHaveLength(1);
    expect(plan.done).toEqual([{ text: "Subsonic auth + library sync", done: true }]);
    expect(plan.log[0]?.date).toBe("2026-11-10");
    expect(plan.log[0]?.text).toBe("scaffolded project, chose media_kit over just_audio");
    expect(result.warnings).toEqual([]);
  });

  it("reports a missing plan block", () => {
    const result = parsePlan("# Nothing here\n");
    expect(result).toMatchObject({ ok: false, reason: "missing" });
  });

  it("reports an unknown status as malformed", () => {
    const text = README.replace("status: in-progress", "status: almost-done");
    expect(parsePlan(text)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("reports an unsupported version", () => {
    const text = README.replace("version=1", "version=2");
    expect(parsePlan(text)).toMatchObject({ ok: false, reason: "unsupported-version" });
  });

  it("reports a missing frontmatter as malformed", () => {
    const text = README.replace("---\nproject: 01-music-player", "project: 01-music-player");
    expect(parsePlan(text)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("warns when the task lists are over budget", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => `- [ ] task ${index}`).join("\n");
    const text = README.replace(
      /## Now\n- \[ \] Wire media_kit into the player service\n- \[x\] Persist queue state across restarts/,
      `## Now\n${tasks}`,
    );
    const result = parsePlan(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("## Now has 9 items");
  });
});

describe("staleness", () => {
  const now = new Date("2026-11-30T00:00:00Z");

  it("is fresh under a week", () => {
    expect(staleness("2026-11-28T00:00:00Z", now)).toBe("fresh");
  });

  it("is aging between one week and one month", () => {
    expect(staleness("2026-11-10T00:00:00Z", now)).toBe("aging");
  });

  it("is stale after a month", () => {
    expect(staleness("2026-10-01T00:00:00Z", now)).toBe("stale");
  });

  it("is stale when the timestamp cannot be read", () => {
    expect(staleness("not a date", now)).toBe("stale");
  });
});

describe("nowProgress", () => {
  it("counts only the Now list", () => {
    const result = parsePlan(README);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nowProgress(result.plan)).toEqual({ done: 1, total: 2 });
  });
});

describe("requests", () => {
  const doc = [
    "<!-- slate:requests:begin -->",
    "- [ ] #req3 add download retry with backoff",
    "- [ ] #req4 rename the export button",
    "<!-- slate:requests:end -->",
    "",
  ].join("\n");

  it("parses tagged requests", () => {
    expect(parseRequests(doc)).toEqual([
      { id: "#req3", text: "add download retry with backoff", done: false },
      { id: "#req4", text: "rename the export button", done: false },
    ]);
  });

  it("ticks a request when its id appears in the plan log", () => {
    const plan: Plan = {
      project: "x",
      status: "in-progress",
      milestone: undefined,
      agent: "opencode/test",
      updated: "2026-11-10T00:00:00Z",
      goal: "",
      now: [],
      next: [],
      done: [],
      log: [{ date: "2026-11-10", text: "did #req3 (retry with backoff)", raw: "did #req3 (retry with backoff)" }],
    };
    const resolved = resolveRequests(parseRequests(doc), plan);
    expect(resolved[0]?.done).toBe(true);
    expect(resolved[1]?.done).toBe(false);
  });
});

describe("formatPlan", () => {
  it("round-trips a parsed plan", () => {
    const result = parsePlan(README);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = formatPlan(result.plan);
    const again = parsePlan(`<!-- slate:plan:begin project=x version=1 -->\n${rendered}\n<!-- slate:plan:end -->`);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.plan.now).toEqual(result.plan.now);
    expect(again.plan.log).toEqual(result.plan.log);
    expect(again.plan.milestone).toBe(result.plan.milestone);
  });
});

describe("planTemplate", () => {
  it("produces a plan that parses cleanly", () => {
    const body = planTemplate("new-project", new Date("2026-11-10T00:00:00Z"));
    const result = parsePlan(`<!-- slate:plan:begin project=new-project version=1 -->\n${body}\n<!-- slate:plan:end -->`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.project).toBe("new-project");
    expect(result.plan.status).toBe("planning");
    expect(result.plan.now).toHaveLength(1);
  });
});
