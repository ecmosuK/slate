import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/cli.ts");

const created: string[] = [];

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-cli-"));
  created.push(folder);
  return folder;
}

function run(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [cli, ...args, "--cwd", cwd], { encoding: "utf8" });
}

function runExpectingFailure(args: string[], cwd: string): number {
  try {
    execFileSync(process.execPath, [cli, ...args, "--cwd", cwd], { encoding: "utf8" });
  } catch (error) {
    const code = (error as { status?: number }).status;
    return code ?? -1;
  }
  return 0;
}

function git(folder: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: folder,
    encoding: "utf8",
    stdio: "ignore",
  });
}

afterEach(() => {
  while (created.length > 0) {
    const folder = created.pop();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
});

describe("slate init", () => {
  it("creates the readme, the plan block and the harness pointers", () => {
    const folder = makeFolder();
    run(["init"], folder);

    expect(existsSync(join(folder, "README.md"))).toBe(true);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(folder, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(folder, "GEMINI.md"))).toBe(true);
    expect(existsSync(join(folder, ".cursor", "rules", "slate.mdc"))).toBe(true);
    expect(existsSync(join(folder, ".github", "copilot-instructions.md"))).toBe(true);

    const readme = readFileSync(join(folder, "README.md"), "utf8");
    expect(readme).toContain("<!-- slate:plan:begin");
    expect(readme).toContain("## Goal");
  });
});

describe("slate plan ensure", () => {
  it("is idempotent", () => {
    const folder = makeFolder();
    run(["init"], folder);
    const before = readFileSync(join(folder, "README.md"), "utf8");

    const output = run(["plan", "ensure"], folder);
    expect(output).toContain("already present");
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe(before);
  });

  it("adds a plan block to a readme that has none", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "README.md"), "# Project\n\nSome prose.\n", "utf8");
    run(["plan", "ensure"], folder);
    expect(readFileSync(join(folder, "README.md"), "utf8")).toContain("<!-- slate:plan:begin");
  });
});

describe("slate plan log", () => {
  it("appends a log line and refreshes the timestamp", () => {
    const folder = makeFolder();
    run(["init"], folder);
    run(["plan", "log", "first thing done", "--agent", "opencode/test"], folder);

    const readme = readFileSync(join(folder, "README.md"), "utf8");
    expect(readme).toContain("first thing done");
    expect(readme).toContain("agent: opencode/test");
  });
});

describe("slate plan check", () => {
  it("passes on a healthy readme", () => {
    const folder = makeFolder();
    run(["init"], folder);
    expect(run(["plan", "check"], folder).trim()).toBe("ok");
  });

  it("fails when the plan block is malformed", () => {
    const folder = makeFolder();
    run(["init"], folder);
    const readme = readFileSync(join(folder, "README.md"), "utf8");
    writeFileSync(
      join(folder, "README.md"),
      readme.replace("status: planning", "status: whatever"),
      "utf8",
    );
    expect(runExpectingFailure(["plan", "check"], folder)).toBe(1);
  });

  it("fails when prose outside the blocks changed", () => {
    const folder = makeFolder();
    run(["init"], folder);
    git(folder, ["init", "-b", "main"]);
    git(folder, ["add", "."]);
    git(folder, ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    const readme = readFileSync(join(folder, "README.md"), "utf8");
    writeFileSync(join(folder, "README.md"), readme.replace("# ", "## "), "utf8");

    expect(runExpectingFailure(["plan", "check", "--base", "HEAD"], folder)).toBe(3);
  });

  it("passes when only the plan block changed", () => {
    const folder = makeFolder();
    run(["init"], folder);
    git(folder, ["init", "-b", "main"]);
    git(folder, ["add", "."]);
    git(folder, ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    run(["plan", "log", "did a thing", "--agent", "opencode/test"], folder);

    expect(runExpectingFailure(["plan", "check", "--base", "HEAD"], folder)).toBe(0);
  });
});
