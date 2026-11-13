/**
 * A cheap fingerprint of everything on disk that the project page shows.
 *
 * The plan agent, the task runner and the terminal can all change a project from outside the
 * page. Comparing this signature tells the browser whether what it is showing is still current,
 * so the page can refresh itself instead of going stale.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The files whose contents make up a project's visible state. */
function stateFiles(folder: string): string[] {
  return [join(folder, "README.md"), join(folder, "goals.json")];
}

/** A stable hash of a project's README and goals, or null when the folder is gone. */
export function projectSignature(folder: string): string | null {
  if (!existsSync(folder)) return null;

  const hash = createHash("sha1");
  for (const path of stateFiles(folder)) {
    hash.update(path);
    hash.update("\u0000");
    if (existsSync(path)) hash.update(readFileSync(path, "utf8"));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}
