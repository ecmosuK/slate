import { describe, expect, it } from "vitest";

import { findZone, parseAttributes, scanZones, stripZones, upsertZone } from "@slate/shared";

const README = [
  "# 01 Music Player",
  "",
  "A player for the home server.",
  "",
  "<!-- slate:plan:begin project=01-music-player version=1 -->",
  "---",
  "project: 01-music-player",
  "status: in-progress",
  "agent: opencode/test",
  "updated: 2026-11-10T14:03:00Z",
  "---",
  "",
  "## Goal",
  "Ship it.",
  "<!-- slate:plan:end -->",
  "",
  "<!-- slate:status:begin project=01-music-player -->",
  "## Waveform — status",
  "<!-- slate:status:end -->",
  "",
  "Trailing prose stays where it is.",
  "",
].join("\n");

describe("parseAttributes", () => {
  it("reads key=value pairs and ignores anything else", () => {
    expect(parseAttributes(" project=01-music-player version=1")).toEqual({
      project: "01-music-player",
      version: "1",
    });
  });

  it("keeps the first value when a key repeats", () => {
    expect(parseAttributes(" version=1 version=2")).toEqual({ version: "1" });
  });
});

describe("scanZones", () => {
  it("finds every known zone with its attributes", () => {
    const scan = scanZones(README);
    expect(scan.duplicates).toEqual([]);
    expect(scan.unterminated).toEqual([]);
    expect(scan.blocks.map((block) => block.zone)).toEqual(["plan", "status"]);
    expect(scan.blocks[0]?.attrs).toEqual({ project: "01-music-player", version: "1" });
  });

  it("ignores markers inside fenced code blocks", () => {
    const text = ["```md", "<!-- slate:plan:begin project=x -->", "<!-- slate:plan:end -->", "```", ""].join(
      "\n",
    );
    expect(scanZones(text).blocks).toHaveLength(0);
  });

  it("ignores unknown zones instead of failing", () => {
    const text = ["<!-- slate:future:begin project=x -->", "body", "<!-- slate:future:end -->", ""].join("\n");
    const scan = scanZones(text);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.unknownZones).toEqual(["future"]);
  });

  it("reports a duplicated zone", () => {
    const text = [
      "<!-- slate:plan:begin project=x -->",
      "a",
      "<!-- slate:plan:end -->",
      "<!-- slate:plan:begin project=x -->",
      "b",
      "<!-- slate:plan:end -->",
      "",
    ].join("\n");
    expect(scanZones(text).duplicates).toEqual(["plan"]);
  });

  it("reports a zone that is never closed", () => {
    const text = ["<!-- slate:plan:begin project=x -->", "a", ""].join("\n");
    expect(scanZones(text).unterminated).toEqual(["plan"]);
  });

  it("accepts CRLF and a byte order mark", () => {
    const text = "\uFEFF<!-- slate:plan:begin project=x -->\r\nbody\r\n<!-- slate:plan:end -->\r\n";
    const scan = scanZones(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.body).toBe("body");
  });
});

describe("findZone", () => {
  it("returns the block for a zone", () => {
    expect(findZone(README, "status")?.attrs["project"]).toBe("01-music-player");
  });

  it("returns undefined for an absent zone", () => {
    expect(findZone(README, "requests")).toBeUndefined();
  });
});

describe("upsertZone", () => {
  it("replaces the body and leaves everything else byte-for-byte", () => {
    const result = upsertZone(README, "status", "## Waveform — status\n\n**Stage:** done", {
      project: "01-music-player",
    });
    expect(result.changed).toBe(true);
    expect(result.text.startsWith("# 01 Music Player")).toBe(true);
    expect(result.text.endsWith("Trailing prose stays where it is.\n")).toBe(true);
    expect(result.text).toContain("**Stage:** done");
    expect(result.text).toContain("## Goal");
    expect(result.text.indexOf("## Goal")).toBeLessThan(result.text.indexOf("**Stage:** done"));
  });

  it("is idempotent", () => {
    const once = upsertZone(README, "status", "same", { project: "01-music-player" });
    const twice = upsertZone(once.text, "status", "same", { project: "01-music-player" });
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("appends a missing zone after a blank line", () => {
    const text = "# Title\n\nSome prose.\n";
    const result = upsertZone(text, "plan", "body", { project: "x", version: "1" });
    expect(result.text).toContain("# Title\n\nSome prose.\n\n<!-- slate:plan:begin project=x version=1 -->");
    expect(result.text.endsWith("<!-- slate:plan:end -->\n")).toBe(true);
  });

  it("preserves CRLF line endings", () => {
    const text = "# Title\r\n\r\nprose\r\n";
    const result = upsertZone(text, "plan", "body", { project: "x" });
    expect(result.text).toContain("<!-- slate:plan:begin project=x -->\r\nbody\r\n");
  });

  it("preserves a byte order mark", () => {
    const text = "\uFEFF# Title\n\nprose\n";
    const result = upsertZone(text, "plan", "body", { project: "x" });
    expect(result.text.charCodeAt(0)).toBe(0xfeff);
  });
});

describe("stripZones", () => {
  it("removes the zone blocks and keeps the prose", () => {
    const stripped = stripZones(README);
    expect(stripped).toContain("# 01 Music Player");
    expect(stripped).toContain("Trailing prose stays where it is.");
    expect(stripped).not.toContain("slate:plan");
    expect(stripped).not.toContain("slate:status");
  });

  it("returns the document unchanged when there are no zones", () => {
    expect(stripZones("# Title\n\nprose\n")).toBe("# Title\n\nprose\n");
  });

  it("ignores changes inside the blocks", () => {
    const changed = README.replace("Ship it.", "Ship it later.");
    expect(stripZones(changed)).toBe(stripZones(README));
  });

  it("sees changes to prose", () => {
    const changed = README.replace("A player for the home server.", "A better player.");
    expect(stripZones(changed)).not.toBe(stripZones(README));
  });
});
