import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectSignature } from "@/lib/project-signature";

let root: string;
let folder: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-signature-"));
  folder = join(root, "demo");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# demo\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("projectSignature", () => {
  it("is stable when nothing changed", () => {
    expect(projectSignature(folder)).toBe(projectSignature(folder));
  });

  it("changes when the README changes", () => {
    const before = projectSignature(folder);
    writeFileSync(join(folder, "README.md"), "# demo\n\n- [ ] a task\n", "utf8");
    expect(projectSignature(folder)).not.toBe(before);
  });

  it("changes when the goals change", () => {
    const before = projectSignature(folder);
    writeFileSync(join(folder, "goals.json"), '{"goals":[]}', "utf8");
    expect(projectSignature(folder)).not.toBe(before);
  });

  it("is null for a folder that is not there", () => {
    expect(projectSignature(join(root, "missing"))).toBeNull();
  });
});
