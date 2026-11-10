import { listProjects, readConfig, type ProjectFolder } from "@slate/shared";

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

export type { ProjectFolder };
