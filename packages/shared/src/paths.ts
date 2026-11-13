/**
 * Filesystem layout for workspaces and their projects.
 *
 * Workspaces live inside the Slate repository: `<repo>/workspaces/<workspace>/<project>`.
 * The default workspace is "personal" (see DEFAULT_WORKSPACE_NAME in workspace.ts), so its
 * projects sit in `workspaces/personal/<project>` and another workspace can be added beside it
 * later.
 *
 * The path is absolute because the web app, the CLI and any harness may run with a different
 * working directory; this file ships as source and runs everywhere. The location below is the
 * default, and `slate config set root <path>` or SLATE_PROJECTS_ROOT override it.
 */
export const WORKSPACES_ROOT = "C:\\Users\\kaede\\Documents\\projects\\slate\\workspaces";

export const DEFAULT_PROJECTS_ROOT = `${WORKSPACES_ROOT}\\personal`;
