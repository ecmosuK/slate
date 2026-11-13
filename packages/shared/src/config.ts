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
    /** Spend cap in US dollars per model id. Missing or null means uncapped. */
    caps: Record<string, number | null>;
  };
  gemini: {
    apiKey: string | null;
  };
  projectsRoot: string | null;
}

export const EMPTY_CONFIG: SlateConfig = {
  openrouter: { apiKey: null, defaultModel: null, caps: {} },
  gemini: { apiKey: null },
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
  if (typeof value !== "object" || value === null) {
    return {
      openrouter: { ...EMPTY_CONFIG.openrouter },
      gemini: { ...EMPTY_CONFIG.gemini },
      projectsRoot: null,
    };
  }
  const raw = value as Partial<SlateConfig> & { gemini?: { apiKey?: unknown } };
  const openrouter = raw.openrouter ?? { apiKey: null, defaultModel: null, caps: {} };
  const gemini = raw.gemini ?? { apiKey: null };
  const caps: Record<string, number | null> = {};
  const rawCaps =
    openrouter.caps !== null && typeof openrouter.caps === "object" && !Array.isArray(openrouter.caps)
      ? (openrouter.caps as Record<string, unknown>)
      : {};
  for (const [model, value] of Object.entries(rawCaps)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) caps[model] = value;
  }
  return {
    openrouter: {
      apiKey: typeof openrouter.apiKey === "string" ? openrouter.apiKey : null,
      defaultModel: typeof openrouter.defaultModel === "string" ? openrouter.defaultModel : null,
      caps,
    },
    gemini: {
      apiKey: typeof gemini.apiKey === "string" ? gemini.apiKey : null,
    },
    projectsRoot: typeof raw.projectsRoot === "string" ? raw.projectsRoot : null,
  };
}

/** The configured cap for one model, in US dollars. Null when the model is uncapped. */
export function capForModel(config: SlateConfig, modelId: string): number | null {
  const cap = config.openrouter.caps[modelId];
  return typeof cap === "number" && Number.isFinite(cap) ? cap : null;
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
  const gemini = patch.gemini;

  // `null` has to be able to clear a value, so the presence of the key decides, not its value.
  let nextCaps: Record<string, number | null>;
  if (openrouter !== undefined && "caps" in openrouter) {
    if (openrouter.caps === null) {
      nextCaps = {};
    } else {
      nextCaps = { ...current.openrouter.caps };
      for (const [model, value] of Object.entries(openrouter.caps)) {
        if (value === null) delete nextCaps[model];
        else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          nextCaps[model] = value;
        }
      }
    }
  } else {
    nextCaps = current.openrouter.caps;
  }

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
      caps: nextCaps,
    },
    gemini: {
      apiKey:
        gemini !== undefined && "apiKey" in gemini ? gemini.apiKey : current.gemini.apiKey,
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

/** The Gemini API key to use, preferring the environment for CI and one-off shells. */
export function geminiKey(config: SlateConfig = readConfig()): string | null {
  const fromEnv = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return config.gemini.apiKey;
}
