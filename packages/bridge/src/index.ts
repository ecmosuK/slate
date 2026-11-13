export * from "./git.ts";
export * from "./atomic.ts";
export * from "./watcher.ts";
export * from "./safety.ts";
export * from "./status.ts";
export * from "./terminal.ts";
export * from "./pty.ts";
export * from "./preview.ts";
export * from "./run-target.ts";

// Re-export shared helpers that the bridge commonly needs.
export { upsertZone, scanZones, findZone, renderStatusBody, renderStatusBlock } from "@slate/shared";

import * as git from "./git.ts";
import * as atomic from "./atomic.ts";
import * as watcher from "./watcher.ts";
import * as safety from "./safety.ts";
import * as status from "./status.ts";

export default {
  ...git,
  ...atomic,
  ...watcher,
  ...safety,
  ...status,
};