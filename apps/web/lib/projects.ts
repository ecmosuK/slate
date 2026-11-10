import { listProjects, type ProjectFolder } from "@slate/shared";

export const PROJECTS_ROOT =
  process.env.SLATE_PROJECTS_ROOT ?? "C:\\Users\\kaede\\Documents\\projects";

/** Every project under the root, summarised from its README. */
export function projects(): ProjectFolder[] {
  return listProjects(PROJECTS_ROOT);
}

export type { ProjectFolder };
