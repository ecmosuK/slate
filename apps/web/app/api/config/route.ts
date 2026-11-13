import { NextResponse } from "next/server";

import { configPath, maskKey, readConfig, writeConfig } from "@slate/shared";

import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The saved settings. Keys are only ever shown masked. */
export async function GET() {
  const config = readConfig();
  return NextResponse.json({
    hasKey: config.openrouter.apiKey !== null,
    maskedKey: maskKey(config.openrouter.apiKey),
    hasGeminiKey: config.gemini.apiKey !== null,
    maskedGeminiKey: maskKey(config.gemini.apiKey),
    defaultModel: config.openrouter.defaultModel,
    caps: config.openrouter.caps,
    configPath: configPath(),
    projectsRoot: config.projectsRoot,
  });
}

/** Save keys or the default model. */
export async function POST(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as {
    apiKey?: unknown;
    geminiApiKey?: unknown;
    defaultModel?: unknown;
    projectsRoot?: unknown;
    caps?: unknown;
  };

  const patch: Parameters<typeof writeConfig>[0] = {};
  const current = readConfig().openrouter;

  if (typeof payload.apiKey === "string" || typeof payload.defaultModel === "string") {
    patch.openrouter = {
      apiKey:
        typeof payload.apiKey === "string"
          ? (payload.apiKey.trim() === "" ? null : payload.apiKey.trim())
          : current.apiKey,
      defaultModel:
        typeof payload.defaultModel === "string" ? payload.defaultModel : current.defaultModel,
      caps: current.caps,
    };
  }

  if (
    typeof payload.caps === "object" &&
    payload.caps !== null &&
    !Array.isArray(payload.caps)
  ) {
    if (patch.openrouter === undefined)
      patch.openrouter = {
        apiKey: current.apiKey,
        defaultModel: current.defaultModel,
        caps: current.caps,
      };
    patch.openrouter.caps = payload.caps as Record<string, number | null>;
  }

  if (typeof payload.geminiApiKey === "string") {
    const key = payload.geminiApiKey.trim();
    patch.gemini = { apiKey: key === "" ? null : key };
  }

  if (typeof payload.projectsRoot === "string" && payload.projectsRoot.trim() !== "") {
    patch.projectsRoot = payload.projectsRoot.trim();
  }

  const config = writeConfig(patch);
  return NextResponse.json({
    ok: true,
    hasKey: config.openrouter.apiKey !== null,
    maskedKey: maskKey(config.openrouter.apiKey),
    hasGeminiKey: config.gemini.apiKey !== null,
    maskedGeminiKey: maskKey(config.gemini.apiKey),
    defaultModel: config.openrouter.defaultModel,
  });
}
