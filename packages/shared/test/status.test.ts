import { describe, expect, it } from "vitest";

import { renderStatusBlock, upsertStatusBlock, type StatusInput } from "@slate/shared";

const INPUT: StatusInput = {
  project: "01-music-player",
  title: "Waveform",
  stage: "in progress",
  nextMilestone: "M2 playback",
  updated: "2026-11-10",
  tasks: [
    { text: "Subsonic client and auth", done: true },
    { text: "Library sync", done: true },
    { text: "Offline downloads", done: false },
    { text: "Release packaging", done: false },
  ],
  repo: {
    branch: "main",
    shortSha: "a1b2c3d",
    commitAge: "2 hours ago",
    dirty: true,
  },
};

describe("renderStatusBlock", () => {
  it("matches the documented layout", () => {
    expect(renderStatusBlock(INPUT)).toBe(
      [
        "<!-- slate:status:begin project=01-music-player -->",
        "## Waveform — status",
        "",
        "**Stage:** in progress · **Next milestone:** M2 playback · **Updated:** 2026-11-10",
        "",
        "- [x] Subsonic client and auth",
        "- [x] Library sync",
        "- [ ] Offline downloads",
        "- [ ] Release packaging",
        "",
        "Repo: `main` · last commit `a1b2c3d` (2 hours ago) · dirty working tree",
        "<!-- slate:status:end -->",
      ].join("\n"),
    );
  });

  it("is deterministic", () => {
    expect(renderStatusBlock(INPUT)).toBe(renderStatusBlock(INPUT));
  });

  it("keeps at most eight open tasks", () => {
    const many: StatusInput = {
      ...INPUT,
      tasks: Array.from({ length: 12 }, (_, index) => ({ text: `task ${index}`, done: false })),
    };
    const rendered = renderStatusBlock(many);
    expect(rendered.match(/- \[ \]/g)).toHaveLength(8);
  });

  it("says when the tree is clean", () => {
    const clean = renderStatusBlock({
      ...INPUT,
      repo: { branch: "main", shortSha: "a1b2c3d", commitAge: "2 hours ago", dirty: false },
    });
    expect(clean).toContain("clean working tree");
  });
});

describe("upsertStatusBlock", () => {
  it("writes the block and preserves prose around it", () => {
    const text = "# Title\n\nSome prose.\n\n<!-- slate:status:begin project=x -->\nold\n<!-- slate:status:end -->\n\nMore prose.\n";
    const result = upsertStatusBlock(text, { ...INPUT, project: "x" });
    expect(result.text).toContain("# Title\n\nSome prose.\n");
    expect(result.text).toContain("More prose.");
    expect(result.text).toContain("**Stage:** in progress");
    expect(result.text).not.toContain("\nold\n");
  });

  it("does not rewrite an unchanged file", () => {
    const text = "# Title\n";
    const first = upsertStatusBlock(text, INPUT);
    const second = upsertStatusBlock(first.text, INPUT);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });
});
