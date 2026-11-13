/**
 * Working out what a project should be run with.
 *
 * The preview runs the same thing the user would type in the terminal, so it answers the question
 * "how do I see this?" with one resolver instead of a pile of special cases:
 *
 * - a package.json with a dev/start/serve/preview script runs that script (`npm run dev`),
 * - a Python project runs its own entry point, preferring the framework-aware runner,
 * - anything else static falls back to the built-in static server.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { staticEntryFolder } from "./preview.ts";

export type RunTargetKind = "npm" | "python" | "static";

export interface RunTarget {
  kind: RunTargetKind;
  /** The command the terminal runs, e.g. `npm run dev`. Empty for the built-in static server. */
  command: string;
  /** A short human phrase for the UI, e.g. "Vite dev server". */
  label: string;
  /** A port worth preferring, or null when the process picks one. */
  portHint: number | null;
  /** True when the target runs code rather than serving files. */
  runsCode: boolean;
  /** True when it is a desktop app (pygame/tkinter) that cannot be framed in a preview iframe. */
  native: boolean;
  /** The folder a static server would serve, when kind is static. */
  folder: string | null;
}

const APP_ENTRIES = ["app.py", "main.py", "wsgi.py", "manage.py"];

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickScript(scripts: Record<string, unknown> | null, name: string): string | null {
  const value = scripts === null ? null : scripts[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The module name of an entry file, without the directory part or the extension. */
function entryModule(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.py$/, "");
}

/**
 * Every way this project could be run, best first. The first entry is the default the preview
 * starts; the rest are alternatives (a Vite project that also builds to static files, for example).
 */
export function resolveRunTargets(folder: string): RunTarget[] {
  const targets: RunTarget[] = [];

  const pkg = readJson(join(folder, "package.json"));
  const scripts = pkg === null ? null : (pkg.scripts ?? null);
  const scriptsObject: Record<string, unknown> | null =
    scripts === null || typeof scripts !== "object" ? null : (scripts as Record<string, unknown>);
  const scriptOrder = ["dev", "start", "serve", "preview"];
  let chosen: string | null = null;
  for (const scriptName of scriptOrder) {
    const value = pickScript(scriptsObject, scriptName);
    if (value !== null) {
      chosen = scriptName;
      break;
    }
  }
  if (chosen !== null) {
    const scriptValue = scriptsObject === null ? "" : String(scriptsObject[chosen] ?? "");
    const command = scriptValue.trim() === "" ? "" : `npm run ${chosen}`;
    targets.push({
      kind: "npm",
      command,
      label: `npm run ${chosen}`,
      portHint: null,
      runsCode: false,
      native: false,
      folder: null,
    });
  }

  const staticFolder = staticEntryFolder(folder);
  if (staticFolder !== null) {
    targets.push({
      kind: "static",
      command: "",
      label: "Built-in static server",
      portHint: null,
      runsCode: false,
      native: false,
      folder: staticFolder,
    });
  }

  const appEntry = APP_ENTRIES.map((name) => join(folder, name)).find((path) => existsSync(path)) ?? null;
  if (appEntry !== null) {
    const source = readFileSync(appEntry, "utf8");
    const lower = source.toLowerCase();
    if (lower.includes("from flask import") || lower.includes("import flask") || lower.includes("flask.Flask")) {
      const moduleName = entryModule(appEntry);
      targets.push({
        kind: "python",
        command: `python -m flask --app ${moduleName} run`,
        label: `Flask app (${moduleName})`,
        portHint: 5000,
        runsCode: true,
        native: false,
        folder: null,
      });
      return targets;
    }
    if (lower.includes("from fastapi import") || lower.includes("import fastapi") || lower.includes("fastapi") || lower.includes("FastAPI()")) {
      const moduleName = entryModule(appEntry);
      targets.push({
        kind: "python",
        command: `python -m uvicorn ${moduleName}:app --port 8000`,
        label: `FastAPI app (${moduleName})`,
        portHint: 8000,
        runsCode: true,
        native: false,
        folder: null,
      });
      return targets;
    }
    const native = /\b(pygame|tkinter|tk\b)/i.test(source);
    const moduleName = entryModule(appEntry);
    targets.push({
      kind: "python",
      command: `python ${moduleName}`,
      label: `Python app (${moduleName})`,
      portHint: null,
      runsCode: true,
      native,
      folder: null,
    });
    return targets;
  }

  const pythonish = ["requirements.txt", "pyproject.toml"].some((name) => existsSync(join(folder, name)));
  if (pythonish) {
    targets.push({
      kind: "python",
      command: "python -m http.server",
      label: "Python static server (http.server)",
      portHint: 8000,
      runsCode: false,
      native: false,
      folder: null,
    });
  }

  return targets;
}
