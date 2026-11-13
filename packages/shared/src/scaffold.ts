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
- Read the \`TERMINAL.md\` in the project root for how the terminal and preview panels are used.
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

/**
 * The guide every agent gets for the terminal and preview panels.
 *
 * It lives here, next to the agent instructions, so the CLI and the web app write the same file and
 * the wording cannot drift between them.
 */
export const TERMINAL_GUIDE_FILENAME = "TERMINAL.md";

export const TERMINAL_GUIDE_TEMPLATE = `# Terminal and preview

Slate gives a project two ways to be seen:

- The **terminal** is a real shell in the project folder. It is a pseudo-terminal when node-pty is
  available, so colours, cursor movement and Ctrl+C behave like a normal console. It is how commands
  get run: \`npm run dev\`, \`python -m http.server\`, tests, builds.
- The **preview** is a view of the server the terminal is running. It appears once that server prints
  a port, frames exactly that port, and can be popped out into a real browser tab.

How to use them:

- On Windows, the terminal is a persistent PowerShell session. The first time it opens, Slate
  installs dependencies from \`package.json\`, \`requirements.txt\` or \`pyproject.toml\` when present.
  Each Python project gets its own \`.venv\`; setup repeats when its dependency files change.
- To run something: type the command in the box at the bottom and click **Run** - for example,
  \`npm run dev\`, \`python snake.py\`, \`python -m http.server\`, tests or builds.
- To look at the app: the Preview button appears once the terminal output names a port. Slate never
  starts a server on its own, so nothing runs until you start it in the terminal.
- Minimising or closing the preview only hides the frame; the terminal process keeps running, and
  reopening the preview shows the same server and port. Stop the server from the terminal with Ctrl+C
  (or Stop for a one-command session), and the preview goes away with it.

How a project becomes previewable:

- Give it a command that starts a server and run that command in the terminal: a package script, a
  Flask or FastAPI entry point, \`python -m http.server\` for plain files, or any other dev server.
- The preview follows the port the server prints. A project that previews cleanly can be moved to a
  real website without changes, because there is no Slate-specific layer in front of its files.

Portability:

- Anything the preview shows is portable: it is the project's own server and its real files.
- When a project has its own server tooling (a \`package.json\` with a \`dev\` or \`start\` script, or a
  Python entry point), run that server in the terminal and the preview follows the port it announces.

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

  const guidePath = join(folder, TERMINAL_GUIDE_FILENAME);
  writeFileSync(guidePath, TERMINAL_GUIDE_TEMPLATE, "utf8");
  created.push(TERMINAL_GUIDE_FILENAME);

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

/** Write the terminal and preview guide into a project folder when it is missing. */
export function ensureTerminalGuide(folder: string): { changed: boolean } {
  const guidePath = join(folder, TERMINAL_GUIDE_FILENAME);
  if (existsSync(guidePath)) return { changed: false };
  writeFileSync(guidePath, TERMINAL_GUIDE_TEMPLATE, "utf8");
  return { changed: true };
}
