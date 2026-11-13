import { execFileSync } from "node:child_process";

import { isFreeModel, listModels, type OpenRouterModel } from "@slate/shared";

interface OpencodeApiModel {
  id?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  name?: unknown;
  status?: unknown;
  cost?: { input?: unknown; output?: unknown }[];
  capabilities?: { tools?: unknown };
  limit?: { context?: unknown };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function isZeroCost(cost: OpencodeApiModel["cost"]): boolean {
  if (!Array.isArray(cost) || cost.length === 0) return false;
  return cost.every((tier) => (asNumber(tier.input) ?? 0) === 0 && (asNumber(tier.output) ?? 0) === 0);
}

/** Free models exposed by the local opencode service (providerID "opencode"). */
export function listOpencodeFreeModels(): OpenRouterModel[] {
  try {
    const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
    const raw = execFileSync(command, ["api", "GET", "/api/model"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as { data?: unknown };
    const rows = Array.isArray(parsed.data) ? (parsed.data as OpencodeApiModel[]) : [];
    const models: OpenRouterModel[] = [];

    for (const row of rows) {
      if (row.providerID !== "opencode") continue;
      if (row.status !== undefined && row.status !== "active") continue;
      if (!isZeroCost(row.cost)) continue;

      const modelID = typeof row.modelID === "string" ? row.modelID : "";
      const rawId = typeof row.id === "string" && row.id !== "" ? row.id : modelID;
      if (rawId === "") continue;
      const id = rawId.startsWith("opencode/") ? rawId : `opencode/${rawId}`;

      models.push({
        id,
        name: typeof row.name === "string" ? row.name : id,
        contextLength: asNumber(row.limit?.context),
        promptPrice: 0,
        completionPrice: 0,
        source: "opencode",
        tools: row.capabilities?.tools === true,
      });
    }

    return models.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function listGeminiFreeModels(): OpenRouterModel[] {
  // Use currently available Gemini Flash model IDs for the direct API (OpenAI-compatible endpoint).
  const models: Array<{ id: string; name: string; contextLength: number }> = [
    { id: "gemini/gemini-3.5-flash", name: "Gemini 3.5 Flash", contextLength: 1_048_576 },
    { id: "gemini/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", contextLength: 1_048_576 },
  ];
  return models.map((model) => ({
    ...model,
    promptPrice: 0,
    completionPrice: 0,
    source: "gemini" as const,
    tools: true,
  }));
}

const BLOCKED_MODEL_IDS = new Set([
  // Restricted to approved "agentic harness" apps on OpenRouter; breaks direct API/chat use.
  "thinkingmachines/inkling-2-small:free",
  "opencode/inkling-2-small-free",
  "inkling-2-small-free",
]);

let modelCache: { models: OpenRouterModel[]; at: number } | null = null;
const MODEL_CACHE_MS = 10 * 60 * 1000;

/** The free model catalogue, cached for ten minutes so the chat route can price turns cheaply. */
export async function cachedListModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  if (modelCache !== null && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models;
  }
  const models = await listFreeModels(fetchImpl);
  modelCache = { models, at: Date.now() };
  return models;
}

/** All free chat models: OpenRouter, Gemini (direct API), and opencode's free models. */
export async function listFreeModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  let openrouter: OpenRouterModel[] = [];
  try {
    openrouter = (await listModels(fetchImpl))
      .filter((model) => isFreeModel(model))
      .filter((model) => !BLOCKED_MODEL_IDS.has(model.id));
  } catch {
    openrouter = [];
  }

  const opencode = listOpencodeFreeModels().filter((model) => !BLOCKED_MODEL_IDS.has(model.id));
  const gemini = listGeminiFreeModels();
  const byId = new Map<string, OpenRouterModel>();

  // Merge in order: OpenRouter catalog, opencode, then Gemini (Gemini ids are namespaced).
  for (const model of [...openrouter, ...opencode, ...gemini]) {
    const existing = byId.get(model.id);
    if (existing === undefined) {
      byId.set(model.id, model);
      continue;
    }
    byId.set(model.id, {
      ...existing,
      source: existing.source ?? model.source,
      tools: existing.tools ?? model.tools ?? null,
      contextLength: existing.contextLength ?? model.contextLength,
    });
  }

  const rank = (source: OpenRouterModel["source"]): number => {
    if (source === "gemini") return 0;
    if (source === "openrouter" || source === undefined) return 1;
    return 2; // opencode
  };

  return [...byId.values()]
    .filter((model) => !BLOCKED_MODEL_IDS.has(model.id))
    .sort((left, right) => {
      const diff = rank(left.source) - rank(right.source);
      if (diff !== 0) return diff;
      return left.name.localeCompare(right.name);
    });
}

export function isRateLimitError(error: string | null | undefined): boolean {
  if (error === null || error === undefined) return false;
  const text = error.toLowerCase();
  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate-limited") ||
    text.includes("temporarily rate")
  );
}

/** Errors worth trying another model for, before any tool actions have run. */
export function shouldFallbackModel(error: string | null | undefined): boolean {
  if (error === null || error === undefined) return false;
  if (isRateLimitError(error)) return true;
  const text = error.toLowerCase();

  // Model-specific access/routing restrictions should fall back to another model.
  if (
    text.includes("only available on agentic harnesses") ||
    text.includes("no allowed providers") ||
    text.includes("no endpoints found") ||
    text.includes("not available for") ||
    text.includes("model not found")
  ) {
    return true;
  }

  // Missing provider key for this specific model - try a different provider/model.
  if (text.includes("no gemini api key") || text.includes("no openrouter key is set")) {
    return true;
  }

  // Authentication/billing/key problems will affect every model the same way.
  if (
    text.includes("401") ||
    text.includes("402") ||
    (text.includes("403") &&
      (text.includes("invalid api key") ||
        text.includes("incorrect api key") ||
        text.includes("unauthorized") ||
        text.includes("authentication") ||
        text.includes("permission denied"))) ||
    text.includes("unauthorized") ||
    text.includes("invalid api key")
  ) {
    return false;
  }

  // Other 403s (e.g. harness-only, routing/policy restrictions) are worth trying another model for.
  if (text.includes("403")) return true;

  return (
    text.includes("400") ||
    text.includes("404") ||
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("provider returned error") ||
    text.includes("invalid argument") ||
    text.includes("does not support") ||
    text.includes("unsupported")
  );
}