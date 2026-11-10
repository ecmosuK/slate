import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  findZone,
  parsePlan,
  parseRequests,
  resolveRequests,
  staleness,
  type Plan,
  type Request,
  type Staleness,
} from "@slate/shared";

export const PROJECTS_ROOT =
  process.env.SLATE_PROJECTS_ROOT ?? "C:\\Users\\kaede\\Documents\\projects";

const IGNORED = new Set(["templates", "node_modules"]);

export interface LinkedProject {
  slug: string;
  folder: string;
  hasReadme: boolean;
  plan: Plan | null;
  planError: string | null;
  warnings: string[];
  requests: Request[];
  staleness: Staleness | null;
  statusBody: string | null;
}

/** Read every project folder under the projects root and parse what is there. */
export function listProjects(root: string = PROJECTS_ROOT): LinkedProject[] {
  if (!existsSync(root)) return [];

  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_") && !name.startsWith(".") && !IGNORED.has(name))
    .sort();

  return folders.map((slug) => readProject(slug, join(root, slug)));
}

export function readProject(slug: string, folder: string): LinkedProject {
  const readmePath = join(folder, "README.md");
  const hasReadme = existsSync(readmePath);

  const project: LinkedProject = {
    slug,
    folder,
    hasReadme,
    plan: null,
    planError: null,
    warnings: [],
    requests: [],
    staleness: null,
    statusBody: null,
  };

  if (!hasReadme) return project;

  const text = readFileSync(readmePath, "utf8");
  const parsed = parsePlan(text);

  if (parsed.ok) {
    project.plan = parsed.plan;
    project.warnings = parsed.warnings;
    project.staleness = staleness(parsed.plan.updated);
    project.requests = resolveRequests(parseRequests(text), parsed.plan);
  } else {
    project.planError = parsed.detail;
  }

  project.statusBody = findZone(text, "status")?.body ?? null;
  return project;
}
