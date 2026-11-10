import { NextResponse } from "next/server";

import { configPath, maskKey, readConfig, writeConfig } from "@slate/shared";

export const dynamic = "force-dynamic";

/** The saved settings. The key is only ever shown masked. */
export async function GET() {
  const config = readConfig();
  return NextResponse.json({
    hasKey: config.openrouter.apiKey !== null,
    maskedKey: maskKey(config.openrouter.apiKey),
    defaultModel: config.openrouter.defaultModel,
    configPath: configPath(),
    projectsRoot: config.projectsRoot,
  });
}

/** Save the OpenRouter key or the default model. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as {
    apiKey?: unknown;
    defaultModel?: unknown;
    projectsRoot?: unknown;
  };

  const patch: Parameters<typeof writeConfig>[0] = {};

  if (typeof payload.apiKey === "string") {
    const key = payload.apiKey.trim();
    patch.openrouter = {
      apiKey: key === "" ? null : key,
      defaultModel:
        typeof payload.defaultModel === "string"
          ? payload.defaultModel
          : readConfig().openrouter.defaultModel,
    };
  } else if (typeof payload.defaultModel === "string") {
    patch.openrouter = {
      apiKey: readConfig().openrouter.apiKey,
      defaultModel: payload.defaultModel,
    };
  }

  if (typeof payload.projectsRoot === "string" && payload.projectsRoot.trim() !== "") {
    patch.projectsRoot = payload.projectsRoot.trim();
  }

  const config = writeConfig(patch);
  return NextResponse.json({
    ok: true,
    hasKey: config.openrouter.apiKey !== null,
    maskedKey: maskKey(config.openrouter.apiKey),
    defaultModel: config.openrouter.defaultModel,
  });
}
