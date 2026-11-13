import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRunTargets } from "@slate/bridge";

const created: string[] = [];

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-run-target-"));
  created.push(folder);
  return folder;
}

afterEach(() => {
  while (created.length) {
    const folder = created.pop();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
});

function writePackage(folder: string, scripts: Record<string, string>): void {
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "x", scripts }, null, 2));
}

describe("resolveRunTargets", () => {
  it("offers both the dev script and the static server when both exist", () => {
    const folder = makeFolder();
    writePackage(folder, { dev: "vite", build: "vite build" });
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    const targets = resolveRunTargets(folder);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ kind: "npm", command: "npm run dev", runsCode: false });
    expect(targets[1]).toMatchObject({ kind: "static" });
  });

  it("picks start when there is no dev script", () => {
    const folder = makeFolder();
    writePackage(folder, { start: "next start" });
    const targets = resolveRunTargets(folder);
    expect(targets[0]).toMatchObject({ kind: "npm", command: "npm run start" });
  });

  it("falls back to the built-in static server for plain html", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    const targets = resolveRunTargets(folder);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "static", command: "", runsCode: false });
  });

  it("runs a flask app with the framework-aware runner", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "app.py"), "from flask import Flask\napp = Flask(__name__)\n");
    const targets = resolveRunTargets(folder);
    expect(targets[0]).toMatchObject({
      kind: "python",
      command: "python -m flask --app app run",
      runsCode: true,
      native: false,
      portHint: 5000,
    });
  });

  it("runs a fastapi app with the framework-aware runner", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
    const targets = resolveRunTargets(folder);
    expect(targets[0]).toMatchObject({
      kind: "python",
      command: "python -m uvicorn main:app --port 8000",
      runsCode: true,
      native: false,
      portHint: 8000,
    });
  });

  it("runs a bare python app and flags native desktop apps", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "app.py"), "import pygame\n\npygame.init()\n");
    const targets = resolveRunTargets(folder);
    expect(targets[0]).toMatchObject({
      kind: "python",
      command: "python app",
      runsCode: true,
      native: true,
    });
  });

  it("uses the python static server when there is no app entry", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "requirements.txt"), "flask\n");
    const targets = resolveRunTargets(folder);
    expect(targets[0]).toMatchObject({
      kind: "python",
      command: "python -m http.server",
      runsCode: false,
      native: false,
      portHint: 8000,
    });
  });

  it("returns nothing for a folder with no runnable shape yet", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "README.md"), "# nothing yet\n");
    expect(resolveRunTargets(folder)).toEqual([]);
  });

  it("never returns a static target without a folder", () => {
    const folder = makeFolder();
    writePackage(folder, { dev: "vite" });
    for (const target of resolveRunTargets(folder)) {
      if (target.kind === "static") expect(target.folder).not.toBeNull();
    }
  });
});
