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
    const raw = execFileSync("opencode", ["api", "GET", "/api/model"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as { data?: unknown };
    const rows = Array.isArray(parsed.data) ? (parsed.data as OpencodeApiModel[]) : [];
    const models: OpenRouterModel[] = [];

    for (const row of rows) {
      if (row.providerID !== "opencode") continue;
      if (row.status !== undefined && row.status !== "active") continue;
      if (!isZeroCost(row.cost)) continue;

      const modelID = typeof row.modelID === "string" ? row.modelID : "";
      const id =
        typeof row.id === "string" && row.id !== ""
          ? row.id
          : modelID === ""
            ? ""
            : `opencode/${modelID}`;
      if (id === "") continue;

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

/** All free chat models: OpenRouter :free/router models plus opencode's free models. */
export async function listFreeModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  let openrouter: OpenRouterModel[] = [];
  try {
    openrouter = (await listModels(fetchImpl)).filter((model) => isFreeModel(model));
  } catch {
    openrouter = [];
  }

  const opencode = listOpencodeFreeModels();
  const byId = new Map<string, OpenRouterModel>();

  // Prefer opencode's own listing for opencode-provider ids; OpenRouter ids come from OpenRouter.
  for (const model of [...openrouter, ...opencode]) {
    const existing = byId.get(model.id);
    if (existing === undefined) {
      byId.set(model.id, model);
      continue;
    }
    // Merge: keep a known source/name, prefer explicit tools flag.
    byId.set(model.id, {
      ...existing,
      source: existing.source ?? model.source,
      tools: existing.tools ?? model.tools ?? null,
      contextLength: existing.contextLength ?? model.contextLength,
    });
  }

  return [...byId.values()].sort((left, right) => {
    const leftSource = left.source ?? "openrouter";
    const rightSource = right.source ?? "openrouter";
    if (leftSource !== rightSource) return leftSource === "opencode" ? -1 : 1;
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