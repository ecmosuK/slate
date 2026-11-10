/**
 * The `slate` command.
 *
 * One binary, no runtime dependency, offline-first. It is what every harness hook calls, so it
 * has to be fast, quiet, and fail open: a broken CLI must never stop an agent from working.
 *
 * Exit codes:
 *   0  ok
 *   1  malformed
 *   2  missing
 *   3  content changed outside the zone blocks
 *   4  wrong project id
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

import {
  findZone,
  formatPlan,
  listProjects,
  parsePlan,
  planTemplate,
  scanZones,
  stripZones,
  summarizePortfolio,
  upsertZone,
  type Plan,
} from "@slate/shared";

const AGENTS_TEXT = `# Agent instructions

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

const POINTER_TEXT = `# Project instructions

The authoritative instructions for this project live in \`AGENTS.md\`. Read that file.

It describes the Slate plan protocol: the \`slate:plan\` block in \`README.md\` is the contract
between the agent and the Slate app.
`;

interface Args {
  command: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      command.push(token);
      continue;
    }
    const [name, inlineValue] = token.slice(2).split("=", 2);
    const key = name ?? "";
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, flags };
}

function flagString(args: Args, name: string, fallback: string): string {
  const value = args.flags[name];
  return typeof value === "string" ? value : fallback;
}

function cwdOf(args: Args): string {
  return resolve(flagString(args, "cwd", process.cwd()));
}

function slugOf(folder: string): string {
  return (
    basename(folder)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function readmePath(folder: string): string {
  return join(folder, "README.md");
}

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function agentOf(args: Args): string {
  return flagString(args, "agent", process.env["SLATE_AGENT"] ?? "unknown");
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Insert a log line and refresh the frontmatter, without reformatting the agent's own text. */
function appendLog(body: string, entry: string, agent: string, updated: string): string {
  const lines = body.split("\n");
  const logIndex = lines.findIndex((line) => /^##\s+log\s*$/i.test(line));

  let insertAt = lines.length;
  if (logIndex !== -1) {
    insertAt = logIndex + 1;
    while (insertAt < lines.length && (lines[insertAt] ?? "").trim() === "") insertAt += 1;
    while (insertAt > logIndex + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt -= 1;
  }

  lines.splice(insertAt, 0, entry);

  const updatedLines = lines.map((line) => {
    if (/^updated\s*:/.test(line)) return `updated: ${updated}`;
    if (/^agent\s*:/.test(line)) return `agent: ${agent}`;
    return line;
  });

  return updatedLines.join("\n");
}

function commandInit(args: Args): number {
  const folder = cwdOf(args);
  mkdirSync(folder, { recursive: true });

  const slug = slugOf(folder);
  const readme = readmePath(folder);

  const base = existsSync(readme) ? readFileSync(readme, "utf8") : `# ${slug}\n`;
  const result = upsertZone(base, "plan", planTemplate(slug), { project: slug, version: "1" });
  writeFileSync(readme, result.text, "utf8");

  const agentsPath = join(folder, "AGENTS.md");
  if (!existsSync(agentsPath)) writeFileSync(agentsPath, AGENTS_TEXT, "utf8");

  const pointerPaths = [
    join(folder, "CLAUDE.md"),
    join(folder, "GEMINI.md"),
    join(folder, ".cursor", "rules", "slate.mdc"),
    join(folder, ".github", "copilot-instructions.md"),
  ];
  for (const path of pointerPaths) {
    if (existsSync(path)) continue;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, POINTER_TEXT, "utf8");
  }

  process.stdout.write(`initialised ${folder}\n`);
  return 0;
}

function commandPlanEnsure(args: Args): number {
  const folder = cwdOf(args);
  const slug = slugOf(folder);
  const path = readmePath(folder);

  const existing = readOrEmpty(path);
  if (existing !== "") {
    const scan = scanZones(existing);
    if (scan.duplicates.length > 0) {
      process.stderr.write(`duplicate zones: ${scan.duplicates.join(", ")}\n`);
      return 1;
    }
    if (findZone(existing, "plan") !== undefined) {
      process.stdout.write("plan block already present\n");
      return 0;
    }
  }

  const body = planTemplate(slug);
  const base = existing === "" ? `# ${slug}\n` : existing;
  const result = upsertZone(base, "plan", body, { project: slug, version: "1" });
  writeFileSync(path, result.text, "utf8");
  process.stdout.write("plan block created\n");
  return 0;
}

function commandPlanRead(args: Args): number {
  const folder = cwdOf(args);
  const path = readmePath(folder);
  if (!existsSync(path)) {
    process.stderr.write("no README.md\n");
    return 2;
  }

  const text = readFileSync(path, "utf8");
  const parsed = parsePlan(text);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.reason}: ${parsed.detail}\n`);
    return parsed.reason === "missing" ? 2 : 1;
  }

  if (args.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(parsed.plan, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPlan(parsed.plan)}\n`);
  }
  return 0;
}

function commandPlanLog(args: Args): number {
  const folder = cwdOf(args);
  const path = readmePath(folder);
  const message = args.command.slice(2).join(" ");
  if (message.trim() === "") {
    process.stderr.write("nothing to log\n");
    return 1;
  }
  if (!existsSync(path)) {
    process.stderr.write("no README.md\n");
    return 2;
  }

  const text = readFileSync(path, "utf8");
  const block = findZone(text, "plan");
  if (block === undefined) {
    process.stderr.write("no plan block\n");
    return 2;
  }

  const updated = nowIso();
  const date = updated.slice(0, 10);
  const body = appendLog(block.body, `- ${date} — ${message.trim()}`, agentOf(args), updated);
  const result = upsertZone(text, "plan", body, { project: block.attrs["project"] ?? slugOf(folder), version: "1" });
  writeFileSync(path, result.text, "utf8");
  process.stdout.write("logged\n");
  return 0;
}

function commandPlanCheck(args: Args): number {
  const folder = cwdOf(args);
  const path = readmePath(folder);
  if (!existsSync(path)) {
    process.stderr.write("no README.md\n");
    return 2;
  }

  const text = readFileSync(path, "utf8");
  const scan = scanZones(text);
  if (scan.duplicates.length > 0) {
    process.stderr.write(`duplicate zones: ${scan.duplicates.join(", ")}\n`);
    return 1;
  }
  if (scan.unterminated.length > 0) {
    process.stderr.write(`unterminated zones: ${scan.unterminated.join(", ")}\n`);
    return 1;
  }

  const parsed = parsePlan(text);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.reason}: ${parsed.detail}\n`);
    return parsed.reason === "missing" ? 2 : 1;
  }

  const plan: Plan = parsed.plan;
  const expected = slugOf(folder);
  if (plan.project !== expected) {
    process.stderr.write(`project id is "${plan.project}" but the folder is "${expected}"\n`);
    return 4;
  }

  const base = flagString(args, "base", "");
  if (base !== "") {
    const before = readBaseReadme(folder, base);
    if (before !== null) {
      if (stripZones(before) !== stripZones(text)) {
        process.stderr.write("content outside the zone blocks changed\n");
        return 3;
      }
      const beforeStatus = findZone(before, "status")?.body ?? "";
      const nowStatus = findZone(text, "status")?.body ?? "";
      if (beforeStatus !== nowStatus) {
        process.stderr.write("the status block changed; only Slate may write it\n");
        return 3;
      }
    }
  }

  for (const warning of parsed.warnings) process.stderr.write(`warning: ${warning}\n`);
  process.stdout.write("ok\n");
  return 0;
}

function readBaseReadme(folder: string, ref: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:README.md`], {
      cwd: folder,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

function commandStatus(args: Args): number {
  const root = flagString(
    args,
    "root",
    process.env["SLATE_PROJECTS_ROOT"] ?? "C:\\Users\\kaede\\Documents\\projects",
  );
  const list = listProjects(root);
  const rollup = summarizePortfolio(list);

  if (args.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify({ root, rollup, projects: list }, null, 2)}\n`);
    return 0;
  }

  if (list.length === 0) {
    process.stdout.write(`no projects under ${root}\n`);
    return 0;
  }

  const width = Math.max(...list.map((project) => project.slug.length));
  for (const project of list) {
    const name = project.slug.padEnd(width);
    const status = (project.status ?? "unknown").padEnd(12);
    const tasks =
      project.tasks.total === 0
        ? "  -  "
        : `${String(project.tasks.done).padStart(2)}/${String(project.tasks.total).padEnd(2)}`;
    const milestone = project.milestone ?? "";
    const branch =
      project.git === null || project.git.branch === null
        ? ""
        : ` (${project.git.branch}${project.git.dirty ? " *" : ""})`;
    process.stdout.write(`${name}  ${status}  ${tasks}  ${milestone}${branch}\n`);
  }

  process.stdout.write(
    `\n${rollup.projects} project(s), ${rollup.withPlan} with a plan block, ` +
      `${rollup.tasksDone}/${rollup.tasksTotal} tasks done` +
      (rollup.blocked > 0 ? `, ${rollup.blocked} blocked` : "") +
      "\n",
  );
  return 0;
}

function commandDoctor(args: Args): number {
  const folder = cwdOf(args);
  const problems: string[] = [];

  const path = readmePath(folder);
  if (!existsSync(path)) {
    problems.push("no README.md");
  } else {
    const parsed = parsePlan(readFileSync(path, "utf8"));
    if (!parsed.ok) problems.push(`plan block: ${parsed.reason} (${parsed.detail})`);
  }

  for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    if (!existsSync(join(folder, name))) problems.push(`missing ${name}`);
  }

  if (problems.length === 0) {
    process.stdout.write("all good\n");
    return 0;
  }
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return 1;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const [first, second] = args.command;

  switch (first) {
    case "init":
      return commandInit(args);
    case "plan":
      switch (second) {
        case "ensure":
          return commandPlanEnsure(args);
        case "read":
          return commandPlanRead(args);
        case "log":
          return commandPlanLog(args);
        case "check":
          return commandPlanCheck(args);
        default:
          process.stderr.write("usage: slate plan <ensure|read|log|check>\n");
          return 1;
      }
    case "status":
      return commandStatus(args);
    case "doctor":
      return commandDoctor(args);
    default:
      process.stderr.write("usage: slate <init|plan|status|doctor>\n");
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
