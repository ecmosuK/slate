/**
 * Reading a project README and saying where it stands.
 *
 * Two paths, in order of confidence:
 *
 * 1. The structured blocks (`slate:plan`, `slate:status`) give exact answers when a project uses
 *    the protocol.
 * 2. Otherwise, the summary is inferred from an ordinary README: headings, checkboxes, bold
 *    `**Status:**` labels, and a first paragraph that reads like a goal.
 *
 * The second path matters more than it looks. A dashboard that only understands projects which
 * follow the protocol is a dashboard most projects do not appear in.
 */

import { parsePlan, type Plan, type PlanTask } from "./plan.ts";
import { findZone } from "./zones.ts";

export interface TaskCounts {
  done: number;
  total: number;
}

export interface ProjectSummary {
  /** Folder name, used when the README has no title. */
  slug: string;
  title: string | null;
  goal: string | null;
  status: string | null;
  milestone: string | null;
  nextSteps: string[];
  tasks: TaskCounts;
  /** Every checkbox in the document, including the ones already ticked. */
  taskItems: PlanTask[];
  /** Headings in the document, in order. */
  sections: string[];
  /** The parsed plan block, when there is one. */
  plan: Plan | null;
  /** Why the summary looks the way it does. */
  source: "plan" | "heuristic" | "empty";
  warnings: string[];
}

const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const STATUS_LABEL = /^\*\*\s*(?:stage|status)\s*:\*\*\s*(.+?)\s*$/i;
const MILESTONE_LABEL = /^\*\*\s*(?:next milestone|milestone|next|up next)\s*:\*\*\s*(.+?)\s*$/i;
const GOAL_HEADING = /^(goal|what this is|purpose|overview|about|summary)$/i;
const NEXT_HEADING = /^(next|next steps|next up|up next|todo|to do|to-do|upcoming|backlog|roadmap|milestones?|immediate next)$/i;
const MILESTONE_HEADING = /^(current milestone|milestone|stage|current stage|status|progress)$/i;
const BADGE_LINE = /^\s*!?\[.*\]\(.*\)\s*$/;

interface Line {
  text: string;
  heading: string | null;
  level: number;
  inFence: boolean;
}

function readLines(text: string): Line[] {
  const lines: Line[] = [];
  let fence = false;

  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      lines.push({ text: raw, heading: null, level: 0, inFence: true });
      continue;
    }
    if (fence) {
      lines.push({ text: raw, heading: null, level: 0, inFence: true });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    lines.push({
      text: raw,
      heading: heading === null ? null : (heading[2] ?? "").trim(),
      level: heading === null ? 0 : (heading[1] ?? "").length,
      inFence: false,
    });
  }

  return lines;
}

function sectionBody(lines: Line[], heading: RegExp): string[] {
  const body: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.inFence) continue;
    if (line.heading !== null) {
      inside = heading.test(line.heading);
      continue;
    }
    if (inside) body.push(line.text);
  }
  return body;
}

function firstMeaningfulLine(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("<!--")) continue;
    if (trimmed.startsWith("|") || trimmed.startsWith(">")) continue;
    if (BADGE_LINE.test(trimmed)) continue;
    if (BULLET.test(trimmed)) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

export interface SummarizeOptions {
  slug: string;
}

/** Describe a project from the text of its README. */
export function summarizeReadme(text: string, options: SummarizeOptions): ProjectSummary {
  const lines = readLines(text);
  const warnings: string[] = [];

  const headings = lines.filter((line) => line.heading !== null && !line.inFence);
  const sections = headings.map((line) => line.heading ?? "");

  const titleHeading = headings.find((line) => line.level === 1);
  const title = titleHeading?.heading ?? null;

  const planResult = parsePlan(text);
  const plan = planResult.ok ? planResult.plan : null;
  if (!planResult.ok && planResult.reason === "malformed") {
    warnings.push(`plan block is malformed: ${planResult.detail}`);
  }

  let status: string | null = null;
  let milestone: string | null = null;
  let goal: string | null = null;
  const nextSteps: string[] = [];

  for (const line of lines) {
    if (line.inFence) continue;
    const statusMatch = STATUS_LABEL.exec(line.text.trim());
    if (statusMatch !== null && status === null) status = (statusMatch[1] ?? "").trim();
    const milestoneMatch = MILESTONE_LABEL.exec(line.text.trim());
    if (milestoneMatch !== null && milestone === null) milestone = (milestoneMatch[1] ?? "").trim();
  }

  const goalBody = sectionBody(lines, GOAL_HEADING);
  goal = firstMeaningfulLine(goalBody);

  const milestoneBody = sectionBody(lines, MILESTONE_HEADING);
  if (milestone === null) milestone = firstMeaningfulLine(milestoneBody);

  const nextBody = sectionBody(lines, NEXT_HEADING);
  for (const line of nextBody) {
    const bullet = BULLET.exec(line);
    if (bullet === null) continue;
    const value = (bullet[1] ?? "").trim();
    if (value === "") continue;
    nextSteps.push(value);
  }

  let done = 0;
  let total = 0;
  const taskItems: PlanTask[] = [];
  for (const line of lines) {
    if (line.inFence) continue;
    const checkbox = CHECKBOX.exec(line.text);
    if (checkbox === null) continue;
    const text = (checkbox[2] ?? "").trim();
    total += 1;
    const checked = (checkbox[1] ?? " ").toLowerCase() === "x";
    if (checked) done += 1;
    taskItems.push({ text, done: checked });
  }

  if (goal === null) {
    const paragraphs: string[] = [];
    let seenTitle = false;
    for (const line of lines) {
      if (line.inFence) continue;
      if (line.heading !== null) {
        if (line.level === 1) seenTitle = true;
        continue;
      }
      if (!seenTitle) continue;
      paragraphs.push(line.text);
    }
    goal = firstMeaningfulLine(paragraphs);
  }

  if (plan !== null) {
    status = status ?? plan.status;
    milestone = milestone ?? plan.milestone ?? null;
    goal = goal ?? (plan.goal === "" ? null : plan.goal);
    warnings.push(...planResult.ok ? planResult.warnings : []);
  }

  const statusBlock = findZone(text, "status");
  if (statusBlock !== undefined && goal === null) {
    const body = firstMeaningfulLine(statusBlock.body.split(/\r\n|\n|\r/));
    if (body !== null) goal = body;
  }

  const source: ProjectSummary["source"] =
    plan !== null ? "plan" : total > 0 || status !== null || goal !== null ? "heuristic" : "empty";

  return {
    slug: options.slug,
    title,
    goal,
    status,
    milestone,
    nextSteps,
    tasks: { done, total },
    taskItems,
    sections,
    plan,
    source,
    warnings,
  };
}

/** A rollup across every project, for the dashboard header. */
export interface PortfolioSummary {
  projects: number;
  withPlan: number;
  tasksDone: number;
  tasksTotal: number;
  /** Projects with nothing to show: no title, no goal, no status, no tasks. */
  empty: number;
  /** Projects whose plan says they are blocked. */
  blocked: number;
}

export function summarizePortfolio(summaries: ProjectSummary[]): PortfolioSummary {
  return {
    projects: summaries.length,
    withPlan: summaries.filter((summary) => summary.plan !== null).length,
    tasksDone: summaries.reduce((total, summary) => total + summary.tasks.done, 0),
    tasksTotal: summaries.reduce((total, summary) => total + summary.tasks.total, 0),
    empty: summaries.filter((summary) => summary.source === "empty").length,
    blocked: summaries.filter((summary) => summary.plan?.status === "blocked").length,
  };
}
