/**
 * The Slate-owned status block.
 *
 * Rendering is deterministic: the same tracker state and the same repo facts produce byte-identical
 * output, so an unchanged project is never rewritten. Nothing here reads the clock.
 */

import { upsertZone, type UpsertResult } from "./zones.ts";

export interface StatusTask {
  text: string;
  done: boolean;
}

export interface StatusLink {
  label: string;
  url: string;
}

export interface RepoFacts {
  branch: string;
  shortSha: string;
  /** Human readable age of the last commit, for example "2 hours ago". */
  commitAge: string;
  dirty: boolean;
  remoteUrl?: string;
}

export interface StatusInput {
  project: string;
  title: string;
  stage: string;
  nextMilestone?: string;
  nextDue?: string;
  /** `YYYY-MM-DD`. Passed in so the renderer stays deterministic. */
  updated: string;
  tasks: StatusTask[];
  links?: StatusLink[];
  repo?: RepoFacts;
}

export const STATUS_LIMITS = {
  openTasks: 8,
  doneTasks: 5,
} as const;

function renderTask(task: StatusTask): string {
  return `- [${task.done ? "x" : " "}] ${task.text}`;
}

/** Render the body of the status block, without the markers. */
export function renderStatusBody(input: StatusInput): string {
  const done = input.tasks.filter((task) => task.done).slice(-STATUS_LIMITS.doneTasks);
  const open = input.tasks.filter((task) => !task.done).slice(0, STATUS_LIMITS.openTasks);

  const lines: string[] = [];
  lines.push(`## ${input.title} — status`);
  lines.push("");

  const headline: string[] = [`**Stage:** ${input.stage}`];
  if (input.nextMilestone !== undefined && input.nextMilestone !== "") {
    headline.push(`**Next milestone:** ${input.nextMilestone}`);
  }
  if (input.nextDue !== undefined && input.nextDue !== "") {
    headline.push(`**Due:** ${input.nextDue}`);
  }
  headline.push(`**Updated:** ${input.updated}`);
  lines.push(headline.join(" · "));
  lines.push("");

  if (done.length > 0 || open.length > 0) {
    for (const task of done) lines.push(renderTask(task));
    for (const task of open) lines.push(renderTask(task));
    lines.push("");
  }

  if (input.links !== undefined && input.links.length > 0) {
    const rendered = input.links.map((link) => `[${link.label}](${link.url})`).join(" · ");
    lines.push(`Links: ${rendered}`);
    lines.push("");
  }

  if (input.repo !== undefined) {
    const tree = input.repo.dirty ? "dirty working tree" : "clean working tree";
    lines.push(
      `Repo: \`${input.repo.branch}\` · last commit \`${input.repo.shortSha}\` (${input.repo.commitAge}) · ${tree}`,
    );
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Render the complete status block, markers included. */
export function renderStatusBlock(input: StatusInput): string {
  return `<!-- slate:status:begin project=${input.project} -->\n${renderStatusBody(input)}\n<!-- slate:status:end -->`;
}

/**
 * Write the status block into a README, replacing any existing status block and preserving
 * everything else byte-for-byte.
 */
export function upsertStatusBlock(text: string, input: StatusInput): UpsertResult {
  return upsertZone(text, "status", renderStatusBody(input), { project: input.project });
}
