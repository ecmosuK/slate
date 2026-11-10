/**
 * Reading projects from disk.
 *
 * Everything here is Node-only. The parsing itself lives in `readme.ts` and stays pure, so the
 * same code can run in a browser later.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { summarizeReadme, type ProjectSummary } from "./readme.ts";

export interface GitFacts {
  branch: string | null;
  shortSha: string | null;
  committedAt: string | null;
  dirty: boolean;
}

export interface ProjectFolder extends ProjectSummary {
  folder: string;
  readmePath: string | null;
  /** When the README was last written, as an ISO timestamp. */
  updatedAt: string | null;
  git: GitFacts | null;
}

const IGNORED = new Set(["templates", "node_modules", "dist", "build", ".next", ".git"]);

function gitFacts(folder: string): GitFacts | null {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", folder, ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  if (run(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const head = run(["log", "-1", "--format=%h|%cI"]);
  const [shortSha = null, committedAt = null] = (head ?? "").split("|");
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || null;
  const status = run(["status", "--porcelain"]);

  return {
    branch,
    shortSha: shortSha ?? null,
    committedAt: committedAt ?? null,
    dirty: status !== null && status !== "",
  };
}

/** Summarise one project folder. */
export function readProject(folder: string, slug: string = basename(folder)): ProjectFolder {
  const readmePath = join(folder, "README.md");
  const hasReadme = existsSync(readmePath);

  const text = hasReadme ? readFileSync(readmePath, "utf8") : "";
  const summary = summarizeReadme(text, { slug });

  let updatedAt: string | null = null;
  if (hasReadme) {
    try {
      updatedAt = statSync(readmePath).mtime.toISOString();
    } catch {
      updatedAt = null;
    }
  }
  if (summary.plan !== null) updatedAt = summary.plan.updated;

  return {
    ...summary,
    folder,
    readmePath: hasReadme ? readmePath : null,
    updatedAt,
    git: gitFacts(folder),
  };
}

export interface ListOptions {
  /** Include folders that start with a dot or an underscore. */
  includeHidden?: boolean;
  /** Look inside each folder for git facts. */
  git?: boolean;
}

/** Summarise every project folder under a root. */
export function listProjects(root: string, options: ListOptions = {}): ProjectFolder[] {
  if (!existsSync(root)) return [];

  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      if (!options.includeHidden && (name.startsWith(".") || name.startsWith("_"))) return false;
      return !IGNORED.has(name);
    })
    .sort();

  return folders.map((name) => {
    const folder = join(root, name);
    const project = readProject(folder, name);
    if (options.git === false) project.git = null;
    return project;
  });
}
