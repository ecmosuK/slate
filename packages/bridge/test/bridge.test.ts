import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  atomicWrite,
  gitFacts,
  repoFacts,
  watchFolder,
  isAllowedPath,
  isRefusedPath,
} from "@slate/bridge";

const created: string[] = [];
function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-bridge-"));
  created.push(folder);
  return folder;
}
afterEach(() => {
  while (created.length) {
    const f = created.pop();
    if (f) rmSync(f, { recursive: true, force: true });
  }
});

describe("atomic writer", () => {
  it("writes and skips unchanged", () => {
    const folder = makeFolder();
    const file = join(folder, "README.md");
    const first = atomicWrite(file, "hello\n");
    expect(first.changed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("hello\n");
    const second = atomicWrite(file, "hello\n");
    expect(second.changed).toBe(false);
    expect(second.skipped).toBe(true);
  });

  it("keeps a history ring", () => {
    const folder = makeFolder();
    const file = join(folder, "README.md");
    const history = join(folder, "history");
    atomicWrite(file, "one\n", { historyDir: history });
    atomicWrite(file, "two\n", { historyDir: history });
    // history should contain one backup
    const fs = require("node:fs");
    const entries = fs.readdirSync(history);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe("git facts", () => {
  it("reads facts from a git repo", () => {
    const folder = makeFolder();
    execFileSync("git", ["init", "-b", "main"], { cwd: folder });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: folder });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: folder });
    writeFileSync(join(folder, "README.md"), "# x\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: folder });
    execFileSync("git", ["commit", "-m", "init"], { cwd: folder });

    const facts = gitFacts(folder);
    expect(facts).not.toBeNull();
    expect(facts!.branch).toBe("main");
    expect(facts!.shortSha).toBeTruthy();
    expect(facts!.dirty).toBe(false);

    const repo = repoFacts(folder);
    expect(repo).not.toBeNull();
    expect(repo!.commitAge).toContain("ago");
  });

  it("returns null for non-repo", () => {
    const folder = makeFolder();
    expect(gitFacts(folder)).toBeNull();
  });
});

describe("watcher", () => {
  it("can be created and closed", () => {
    const folder = makeFolder();
    const watcher = watchFolder(folder, () => {});
    expect(typeof watcher.close).toBe("function");
    watcher.close();
  });
});

describe("safety", () => {
  it("refuses system paths", () => {
    expect(isRefusedPath("C:\\Windows\\System32")).toBe(true);
    expect(isRefusedPath("C:\\")).toBe(true);
  });
  it("allowlist checks", () => {
    const folder = makeFolder();
    expect(isAllowedPath(join(folder, "README.md"), folder)).toBe(true);
    expect(isAllowedPath("C:\\Windows\\x", folder)).toBe(false);
  });
});