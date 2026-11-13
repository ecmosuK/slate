import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { terminalDependencySetup } from "@/lib/terminal-dependencies";

const folders: string[] = [];

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-terminal-deps-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  while (folders.length > 0) {
    const folder = folders.pop();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
});

describe("terminalDependencySetup", () => {
  it("installs the Python requirements for a script project", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "requirements.txt"), "pygame-ce>=2.5.8\n");

    const setup = terminalDependencySetup(folder);
    expect(setup).toMatchObject({ label: "Python dependencies", venvExists: false });
    expect(setup?.command).toContain("python -m venv .venv");
    expect(setup?.command).toContain("python -m pip install");
    expect(setup?.command).toContain("-r requirements.txt");
    expect(setup?.activateCommand).toContain(".venv");
  });

  it("uses the lockfile for npm projects and detects manifest changes", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "package.json"), '{"scripts":{"dev":"next dev"}}');
    writeFileSync(join(folder, "package-lock.json"), '{"lockfileVersion":3}');

    const first = terminalDependencySetup(folder);
    expect(first?.command).toContain("npm ci");

    writeFileSync(join(folder, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
    expect(terminalDependencySetup(folder)?.fingerprint).not.toBe(first?.fingerprint);
  });

  it("installs both Node and Python dependencies when both manifests exist", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "package.json"), "{}");
    writeFileSync(join(folder, "requirements.txt"), "pygame-ce>=2.5.8\n");

    const setup = terminalDependencySetup(folder);
    expect(setup?.command).toContain("npm install");
    expect(setup?.command).toContain("python -m venv .venv");
    expect(setup?.command).toContain("-r requirements.txt");
  });

  it("keeps each pyproject-only project in its own venv", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "pyproject.toml"), "[project]\nname='demo'\n");

    const setup = terminalDependencySetup(folder);
    expect(setup?.command).toContain("python -m venv .venv");
    expect(setup?.command).toContain("pip install");
    expect(setup?.command).toContain(" .");
  });

  it("does nothing when there is no supported manifest", () => {
    expect(terminalDependencySetup(makeFolder())).toBeNull();
  });
});
