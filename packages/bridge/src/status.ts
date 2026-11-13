/**
 * Writing the Slate-owned status block through the atomic writer.
 */

import { readFileSync, existsSync } from "node:fs";

import {
  upsertStatusBlock,
  renderStatusBody,
  type StatusInput,
  type UpsertResult,
} from "@slate/shared";
import { atomicWrite, type AtomicWriteOptions, type AtomicWriteResult } from "./atomic.ts";
import { repoFacts } from "./git.ts";

export interface WriteStatusOptions extends AtomicWriteOptions {
  /** When true, refresh repo facts from disk and merge them in. Defaults to true. */
  refreshRepo?: boolean;
  /** Folder used to read git facts when `input.repo` is missing. */
  folder?: string;
}

export function buildStatusInput(input: StatusInput, options: WriteStatusOptions = {}): StatusInput {
  const refreshRepo = options.refreshRepo ?? true;
  if (!refreshRepo) return input;
  if (input.repo !== undefined) return input;
  const folder = options.folder;
  if (folder === undefined) return input;
  const facts = repoFacts(folder);
  if (facts === null) return input;
  return {
    ...input,
    repo: {
      branch: facts.branch ?? "unknown",
      shortSha: facts.shortSha ?? "unknown",
      commitAge: facts.commitAge,
      dirty: facts.dirty,
      remoteUrl: facts.remoteUrl ?? undefined,
    },
  };
}

export function renderStatusReadme(text: string, input: StatusInput, options: WriteStatusOptions = {}): {
  text: string;
  changed: boolean;
  result: UpsertResult;
} {
  const resolved = buildStatusInput(input, options);
  const result = upsertStatusBlock(text, resolved);
  return { text: result.text, changed: result.changed, result };
}

export function writeStatusBlock(
  readmePath: string,
  input: StatusInput,
  options: WriteStatusOptions = {},
): AtomicWriteResult {
  const current = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const rendered = renderStatusReadme(current, input, options);
  if (!rendered.changed) {
    // Still route through atomicWrite so hashing/skip logic stays consistent.
  }
  return atomicWrite(readmePath, rendered.text, options);
}

export const syncStatusBlock = writeStatusBlock;
export const updateStatusBlock = writeStatusBlock;
export const writeStatus = writeStatusBlock;
export const renderAndWriteStatus = writeStatusBlock;
export const syncStatus = writeStatusBlock;