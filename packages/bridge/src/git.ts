/**
 * Git facts for a project folder.
 *
 * These mirror `packages/shared`'s `GitFacts` shape but are owned by the bridge, because the
 * bridge is the only component that is allowed to shell out to git on the user's machine.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { GitFacts as SharedGitFacts } from "@slate/shared";

export type GitFacts = SharedGitFacts;

export interface RepoFacts {
  branch: string | null;
  shortSha: string | null;
  committedAt: string | null;
  commitAge: string;
  dirty: boolean;
  remoteUrl: string | null;
}

function run(folder: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", folder, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function ageOf(iso: string | null): string {
  if (iso === null) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Read branch, short SHA, commit time and dirty state for a folder. */
export function gitFacts(folder: string): GitFacts | null {
  if (!existsSync(folder)) return null;
  if (run(folder, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const head = run(folder, ["log", "-1", "--format=%h|%cI"]);
  const [shortSha = null, committedAt = null] = (head ?? "").split("|");
  const branch = run(folder, ["rev-parse", "--abbrev-ref", "HEAD"]) || null;
  const status = run(folder, ["status", "--porcelain"]);

  return {
    branch,
    shortSha: shortSha === "" ? null : shortSha ?? null,
    committedAt: committedAt === "" ? null : committedAt ?? null,
    dirty: status !== null && status !== "",
  };
}

/** Same facts, shaped for the status block renderer. */
export function repoFacts(folder: string): RepoFacts | null {
  const facts = gitFacts(folder);
  if (facts === null) return null;
  return {
    branch: facts.branch,
    shortSha: facts.shortSha,
    committedAt: facts.committedAt,
    commitAge: ageOf(facts.committedAt),
    dirty: facts.dirty,
    remoteUrl: run(folder, ["remote", "get-url", "origin"]),
  };
}

export class GitFactsReader {
  facts(folder: string): GitFacts | null {
    return gitFacts(folder);
  }
  repo(folder: string): RepoFacts | null {
    return repoFacts(folder);
  }
}

// Aliases for compatibility with alternate naming.
export const getGitFacts = gitFacts;
export const getRepoFacts = repoFacts;
export const readGitFacts = gitFacts;
export const collectGitFacts = gitFacts;
export const factsForRepo = repoFacts;
export const gitInfo = gitFacts;
export const repoInfo = repoFacts;
export const getRepoInfo = repoFacts;
export const readRepoFacts = repoFacts;
export const collectRepoFacts = repoFacts;