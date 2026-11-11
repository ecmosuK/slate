import { NextResponse } from "next/server";

import { complete, openRouterKey, readConfig } from "@slate/shared";

import { listFreeModels } from "@/lib/free-models";

export const dynamic = "force-dynamic";

let cache: { models: Awaited<ReturnType<typeof listFreeModels>>; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/** Free model catalogue: OpenRouter free models and opencode's free models. */
export async function GET() {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ ok: true, models: cache.models, cached: true, freeOnly: true });
  }
  try {
    const models = await listFreeModels();
    cache = { models, at: Date.now() };
    return NextResponse.json({ ok: true, models, cached: false, freeOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the model list could not be fetched";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

/** Send one small message, to check the key and the model. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { model?: unknown; prompt?: unknown };
  const config = readConfig();
  const model =
    typeof payload.model === "string" && payload.model !== ""
      ? payload.model
      : (config.openrouter.defaultModel ?? "");
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim() !== ""
      ? payload.prompt.trim()
      : "Reply with the single word: connected.";

  if (model === "") {
    return NextResponse.json({ ok: false, error: "choose a model first" }, { status: 400 });
  }

  const key = openRouterKey(config);
  if (key === null) {
    return NextResponse.json({ ok: false, error: "no OpenRouter key is set" }, { status: 400 });
  }

  const result = await complete(key, model, prompt);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
