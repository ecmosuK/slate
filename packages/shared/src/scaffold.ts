/**
 * Creating a project.
 *
 * One implementation, used by the CLI and by the web app, so a project made in the browser is
 * exactly the same as a project made in a terminal. Nothing is written outside the projects root.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute, relative, resolve } from "node:path";

import { planTemplate } from "./plan.ts";
import { upsertZone } from "./zones.ts";

export const AGENTS_TEMPLATE = `# Agent instructions

Before any other action, read the \`slate:plan\` block in \`README.md\`.

- If it is missing, run \`slate plan ensure\` or create it from the template, and set \`project:\`
  to this folder's name.
- Restate the current milestone and the first unchecked task under \`## Now\` in one line, then work.
- Edit only inside the \`slate:plan\` markers. Never touch \`slate:status\`, \`slate:requests\`, or
  any prose outside the blocks.
- Move finished items from \`## Now\` to \`## Done\`.
- Append one line to \`## Log\` per meaningful change.
- Update \`agent\` and \`updated\` on every write.
`;

export const POINTER_TEMPLATE = `# Project instructions

The authoritative instructions for this project live in \`AGENTS.md\`. Read that file.

It describes the Slate plan protocol: the \`slate:plan\` block in \`README.md\` is the contract
between the agent and the Slate app.
`;

/** The pointer files written next to a project, so every harness finds the instructions. */
export const POINTER_FILES = [
  "CLAUDE.md",
  "GEMINI.md",
  join(".cursor", "rules", "slate.mdc"),
  join(".github", "copilot-instructions.md"),
];

/** Turn a name into a safe folder slug. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || ""
  );
}

export class ScaffoldError extends Error {}

export interface ScaffoldOptions {
  name: string;
  /** One line describing the project. Written into the goal. */
  description?: string;
  /** Initialise a git repository. */
  git?: boolean;
}

export interface ScaffoldResult {
  slug: string;
  folder: string;
  created: string[];
}

/** True when `child` is inside `parent`. Used to refuse escapes. */
export function isInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  if (relativePath === "") return false;
  if (relativePath.startsWith("..")) return false;
  return !isAbsolute(relativePath);
}

/**
 * Create a project folder under `root`: a README with the three zones, the agent instructions and
 * the harness pointer files.
 */
export function scaffoldProject(root: string, options: ScaffoldOptions): ScaffoldResult {
  const slug = slugify(options.name);
  if (slug === "") {
    throw new ScaffoldError("a project name is required");
  }

  const rootPath = resolve(root);
  const folder = join(rootPath, slug);
  if (!isInside(rootPath, folder)) {
    throw new ScaffoldError("the project folder would fall outside the projects root");
  }
  if (existsSync(folder)) {
    throw new ScaffoldError(`a folder called ${slug} already exists`);
  }

  mkdirSync(folder, { recursive: true });

  const created: string[] = [];

  const description = options.description?.trim() ?? "";
  const body = planTemplate(slug).replace(
    "## Goal\nOne sentence: what this project is for and what done looks like.",
    `## Goal\n${description === "" ? "One sentence: what this project is for and what done looks like." : description}`,
  );

  const readme = `<!-- slate:plan:begin project=${slug} version=1 -->\n${body}\n<!-- slate:plan:end -->\n\n<!-- slate:status:begin project=${slug} -->\n<!-- slate:status:end -->\n\n<!-- slate:requests:begin -->\n<!-- slate:requests:end -->\n\n# ${slug}\n\n${description}\n`;

  const readmePath = join(folder, "README.md");
  writeFileSync(readmePath, readme, "utf8");
  created.push("README.md");

  const agentsPath = join(folder, "AGENTS.md");
  writeFileSync(agentsPath, AGENTS_TEMPLATE, "utf8");
  created.push("AGENTS.md");

  for (const relative of POINTER_FILES) {
    const path = join(folder, relative);
    if (existsSync(path)) continue;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, POINTER_TEMPLATE, "utf8");
    created.push(relative);
  }

  if (options.git === true) {
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: folder, stdio: "ignore" });
      created.push(".git");
    } catch {
      // A missing git is not a reason to fail the scaffold.
    }
  }

  return { slug, folder, created };
}

/** Add a plan block to an existing folder that has none. */
export function ensurePlanBlock(folder: string): { changed: boolean } {
  const slug = slugify(folder.split(/[\\/]/).filter(Boolean).pop() ?? "project");
  const readmePath = join(folder, "README.md");
  if (!existsSync(readmePath)) return { changed: false };

  const existing = upsertZone(readFileSync(readmePath, "utf8"), "plan", planTemplate(slug), {
    project: slug,
    version: "1",
  });
  if (!existing.changed) return { changed: false };
  writeFileSync(readmePath, existing.text, "utf8");
  return { changed: true };
}
