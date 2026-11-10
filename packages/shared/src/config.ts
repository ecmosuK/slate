/**
 * Local configuration.
 *
 * Lives outside the repository, under the user's local application data, so a key never ends up
 * in a git history. The file is created on demand and written with owner-only permissions where
 * the platform supports it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SlateConfig {
  openrouter: {
    apiKey: string | null;
    defaultModel: string | null;
  };
  projectsRoot: string | null;
}

export const EMPTY_CONFIG: SlateConfig = {
  openrouter: { apiKey: null, defaultModel: null },
  projectsRoot: null,
};

export function configDir(): string {
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "Slate");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg ?? join(homedir(), ".config"), "slate");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

function coerce(value: unknown): SlateConfig {
  if (typeof value !== "object" || value === null) return { ...EMPTY_CONFIG };
  const raw = value as Partial<SlateConfig>;
  const openrouter = raw.openrouter ?? { apiKey: null, defaultModel: null };
  return {
    openrouter: {
      apiKey: typeof openrouter.apiKey === "string" ? openrouter.apiKey : null,
      defaultModel: typeof openrouter.defaultModel === "string" ? openrouter.defaultModel : null,
    },
    projectsRoot: typeof raw.projectsRoot === "string" ? raw.projectsRoot : null,
  };
}

export function readConfig(): SlateConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...EMPTY_CONFIG };
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function writeConfig(patch: Partial<SlateConfig>): SlateConfig {
  const current = readConfig();
  const openrouter = patch.openrouter;

  // `null` has to be able to clear a value, so the presence of the key decides, not its value.
  const next: SlateConfig = {
    openrouter: {
      apiKey:
        openrouter !== undefined && "apiKey" in openrouter
          ? openrouter.apiKey
          : current.openrouter.apiKey,
      defaultModel:
        openrouter !== undefined && "defaultModel" in openrouter
          ? openrouter.defaultModel
          : current.openrouter.defaultModel,
    },
    projectsRoot:
      "projectsRoot" in patch ? (patch.projectsRoot ?? null) : current.projectsRoot,
  };

  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }
  return next;
}

/** A key that can be shown without being usable. */
export function maskKey(key: string | null): string | null {
  if (key === null || key === "") return null;
  if (key.length <= 10) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** The key to use, preferring the environment for CI and one-off shells. */
export function openRouterKey(config: SlateConfig = readConfig()): string | null {
  const fromEnv = process.env["OPENROUTER_API_KEY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return config.openrouter.apiKey;
}
