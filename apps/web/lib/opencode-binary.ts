/**
 * Where the opencode CLI lives.
 *
 * OpenCode is installed by npm on Windows, which leaves a `.cmd` shim and a real `.exe` beside
 * it. Spawning the `.exe` directly avoids `cmd.exe`, which has an 8191-character command-line
 * limit and cannot be given a long prompt.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The opencode executable to spawn, or null when it is not installed. */
export function resolveOpencodeBinary(): string | null {
  const override = process.env.SLATE_OPENCODE_BIN?.trim();
  if (override !== undefined && override !== "") {
    if (isAbsolute(override) && !existsSync(override)) return null;
    return override;
  }

  if (process.platform !== "win32") return "opencode";

  const candidates: string[] = [];
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData !== "") {
    candidates.push(join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") {
    candidates.push(join(localAppData, "Programs", "opencode", "opencode.exe"));
  }

  // A global npm install also leaves opencode.cmd next to node_modules.
  try {
    const lines = execFileSync("where.exe", ["opencode"], {
      encoding: "utf8",
      windowsHide: true,
    }).split(/\r?\n/);
    for (const line of lines) {
      const path = line.trim();
      if (!path.toLowerCase().endsWith("opencode.cmd")) continue;
      candidates.push(join(dirname(path), "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
    }
  } catch {
    // `where` missing or no global install; the candidates above are still worth checking.
  }

  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}
