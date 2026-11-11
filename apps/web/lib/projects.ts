import { join } from "node:path";

import { listProjects, readConfig, isInside, type ProjectFolder } from "@slate/shared";

export const DEFAULT_PROJECTS_ROOT = "C:\\Users\\kaede\\Documents\\projects";

/** Where projects live: the saved setting first, then the environment, then the default. */
export function projectsRoot(): string {
  const config = readConfig();
  return config.projectsRoot ?? process.env.SLATE_PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

/** Every project under the root, summarised from its README. */
export function projects(): ProjectFolder[] {
  return listProjects(projectsRoot());
}

/** Next passes dynamic route segments still percent-encoded; decode them safely. */
export function decodeProjectSlug(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve a slug to a folder inside the projects root.
 * Returns null for traversal attempts, so callers can answer 404 instead of reading elsewhere.
 */
export function projectFolder(slug: string): string | null {
  if (slug === "" || slug === "." || slug === "..") return null;
  const root = projectsRoot();
  const folder = join(root, slug);
  return isInside(root, folder) ? folder : null;
}

export type { ProjectFolder };
