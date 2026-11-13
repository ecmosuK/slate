import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScaffoldError, isInside, scaffoldProject, slugify } from "@slate/shared";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "slate-scaffold-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("slugify", () => {
  it("turns a name into a folder slug", () => {
    expect(slugify("Budget Tracker")).toBe("budget-tracker");
    expect(slugify("  01 Music Player!  ")).toBe("01-music-player");
    expect(slugify("...")).toBe("");
  });
});

describe("isInside", () => {
  it("accepts a child and refuses a sibling", () => {
    expect(isInside("/root", "/root/project")).toBe(true);
    expect(isInside("/root", "/root/other")).toBe(true);
    expect(isInside("/root", "/elsewhere/project")).toBe(false);
  });
});

describe("scaffoldProject", () => {
  it("creates a folder with a readme, instructions and pointer files", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "Budget Tracker", description: "Track spending" });

    expect(result.slug).toBe("budget-tracker");
    expect(existsSync(result.folder)).toBe(true);
    expect(existsSync(join(result.folder, "README.md"))).toBe(true);
    expect(existsSync(join(result.folder, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(result.folder, "TERMINAL.md"))).toBe(true);
    expect(existsSync(join(result.folder, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(result.folder, "GEMINI.md"))).toBe(true);
    expect(existsSync(join(result.folder, ".cursor", "rules", "slate.mdc"))).toBe(true);
    expect(existsSync(join(result.folder, ".github", "copilot-instructions.md"))).toBe(true);
  });

  it("writes the terminal and preview guide into new projects", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "Budget Tracker", description: "Track spending" });

    const guide = readFileSync(join(result.folder, "TERMINAL.md"), "utf8");
    expect(guide).toContain("# Terminal and preview");
    expect(guide).toContain("The **terminal** is a real shell");
    expect(guide).toContain("Each Python project gets its own");
    expect(guide).toContain("The preview follows the port the server prints");
  });

  it("points agents at the terminal and preview guide", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "Budget Tracker", description: "Track spending" });

    const agents = readFileSync(join(result.folder, "AGENTS.md"), "utf8");
    expect(agents).toContain("TERMINAL.md");
  });

  it("writes a readme with the three zones and the description", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "budget", description: "Track household spending" });
    const readme = readFileSync(join(result.folder, "README.md"), "utf8");

    expect(readme).toContain("<!-- slate:plan:begin project=budget version=1 -->");
    expect(readme).toContain("<!-- slate:plan:end -->");
    expect(readme).toContain("<!-- slate:status:begin project=budget -->");
    expect(readme).toContain("<!-- slate:requests:begin -->");
    expect(readme).toContain("Track household spending");
  });

  it("sanitises a name that tries to escape the root", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "../../evil" });
    expect(result.slug).toBe("evil");
    expect(result.folder.startsWith(resolve(root))).toBe(true);
    expect(existsSync(join(root, "evil"))).toBe(true);
  });

  it("refuses to overwrite an existing folder", () => {
    const root = makeRoot();
    scaffoldProject(root, { name: "budget" });
    expect(() => scaffoldProject(root, { name: "budget" })).toThrow(/already exists/);
  });

  it("refuses an empty name", () => {
    const root = makeRoot();
    expect(() => scaffoldProject(root, { name: "   " })).toThrow(ScaffoldError);
  });

  it("starts a git repository when asked", () => {
    const root = makeRoot();
    const result = scaffoldProject(root, { name: "git-project", git: true });
    expect(existsSync(join(result.folder, ".git"))).toBe(true);
  });

  it("makes a project the dashboard can read straight away", () => {
    const root = makeRoot();
    scaffoldProject(root, { name: "readable", description: "A project" });
    const readme = readFileSync(join(root, "readable", "README.md"), "utf8");
    expect(readme).toContain("## Goal");
    expect(readme).toContain("## Now");
    expect(readme).toContain("## Done");
  });
});

describe("nothing is created outside the root", () => {
  it("creates nothing for a name that tries to escape", () => {
    const root = makeRoot();
    const outside = join(root, "..", `evil-${Date.now()}`);
    scaffoldProject(root, { name: "../evil" });
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(root, "evil"))).toBe(true);
  });
});
