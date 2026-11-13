import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listProjects } from "@slate/shared";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-gitfacts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function makeProject(name: string): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), `# ${name}\n`, "utf8");
  return folder;
}

describe("git facts", () => {
  it("reports a project's own repository", () => {
    const folder = makeProject("own-repo");
    git(folder, "init", "-b", "main");
    git(folder, "config", "user.email", "test@example.com");
    git(folder, "config", "user.name", "Test");
    git(folder, "add", "README.md");
    git(folder, "commit", "-m", "first");

    const [project] = listProjects(root);
    expect(project?.git?.branch).toBe("main");
    expect(project?.git?.dirty).toBe(false);
  });

  it("does not report a parent repository's branch as the project's own", () => {
    // A project that only sits inside another repository (a workspace inside Slate, say).
    git(root, "init", "-b", "trunk");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    const folder = makeProject("nested");
    git(root, "add", "nested/README.md");
    git(root, "commit", "-m", "first");

    const [project] = listProjects(root);
    expect(project?.slug).toBe("nested");
    expect(project?.git).toBeNull();
  });
});
