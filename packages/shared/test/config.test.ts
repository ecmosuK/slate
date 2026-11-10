import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configPath, maskKey, openRouterKey, readConfig, writeConfig } from "@slate/shared";

const roots: string[] = [];
const originalLocalAppData = process.env["LOCALAPPDATA"];
const originalKey = process.env["OPENROUTER_API_KEY"];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "slate-config-"));
  roots.push(root);
  process.env["LOCALAPPDATA"] = root;
  delete process.env["OPENROUTER_API_KEY"];
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
  if (originalLocalAppData === undefined) delete process.env["LOCALAPPDATA"];
  else process.env["LOCALAPPDATA"] = originalLocalAppData;
  if (originalKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = originalKey;
});

describe("config", () => {
  it("starts empty", () => {
    const config = readConfig();
    expect(config.openrouter.apiKey).toBeNull();
    expect(config.openrouter.defaultModel).toBeNull();
  });

  it("saves and reads back the key and the model", () => {
    writeConfig({ openrouter: { apiKey: "sk-or-v1-test", defaultModel: "a/model" } });
    const config = readConfig();
    expect(config.openrouter.apiKey).toBe("sk-or-v1-test");
    expect(config.openrouter.defaultModel).toBe("a/model");
  });

  it("keeps the other half of the settings when one changes", () => {
    writeConfig({ openrouter: { apiKey: "sk-or-v1-test", defaultModel: "a/model" } });
    writeConfig({ openrouter: { apiKey: null, defaultModel: "b/model" } });
    const config = readConfig();
    expect(config.openrouter.apiKey).toBeNull();
    expect(config.openrouter.defaultModel).toBe("b/model");
  });

  it("stores the file outside the repository", () => {
    writeConfig({ openrouter: { apiKey: "sk-or-v1-test", defaultModel: null } });
    expect(configPath()).toContain("Slate");
    expect(configPath().endsWith("config.json")).toBe(true);
  });

  it("prefers the environment variable when it is set", () => {
    writeConfig({ openrouter: { apiKey: "from-file", defaultModel: null } });
    expect(openRouterKey()).toBe("from-file");
    process.env["OPENROUTER_API_KEY"] = "from-env";
    expect(openRouterKey()).toBe("from-env");
  });
});

describe("maskKey", () => {
  it("never shows the whole key", () => {
    expect(maskKey("sk-or-v1-abcdefghijklmnop")).toBe("sk-o…mnop");
    expect(maskKey(null)).toBeNull();
    expect(maskKey("")).toBeNull();
    expect(maskKey("short")).toBe("…");
  });
});
