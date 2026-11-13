import { NextResponse } from "next/server";

import { capForModel, complete, geminiKey, openRouterKey, readConfig } from "@slate/shared";

import { cachedListModels } from "@/lib/free-models";
import { modelUnavailabilityOf } from "@/lib/agent-session";
import { DEFAULT_CHAT_MODEL } from "@/lib/model-defaults";
import { capRemainingDollars, formatDollars } from "@/lib/spend";
import { geminiChat } from "@/lib/gemini-chat";
import { completeWithOpencode } from "@/lib/opencode-chat";
import { guardWrite } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Free model catalogue: OpenRouter, Gemini, and opencode's free models. */
export async function GET() {
  try {
    const models = await cachedListModels();
    const enriched = models.map((model) => {
      const unavailable = modelUnavailabilityOf(model.id);
      return {
        ...model,
        unavailableUntil: unavailable === null ? null : unavailable.until,
        unavailableReason: unavailable === null ? null : unavailable.reason,
      };
    });
    return NextResponse.json({ ok: true, models: enriched, freeOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the model list could not be fetched";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

/** Send one small message, to check the key and the model. */
export async function POST(request: Request) {
  const denied = await guardWrite();
  if (denied !== null) return denied;

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
      : (config.openrouter.defaultModel ?? DEFAULT_CHAT_MODEL);
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim() !== ""
      ? payload.prompt.trim()
      : "Reply with the single word: connected.";

  const remaining = capRemainingDollars(config, model);
  if (remaining !== null && remaining <= 0) {
    const cap = capForModel(config, model) ?? 0;
    const spent = cap - remaining;
    return NextResponse.json(
      {
        ok: false,
        error: `spend cap reached for ${model}: $${formatDollars(spent * 1_000_000)} of $${formatDollars(cap * 1_000_000)} spent`,
      },
      { status: 402 },
    );
  }

  if (model.startsWith("opencode/")) {
    const result = await completeWithOpencode(model, "You are a helpful assistant.", [
      { role: "user", content: prompt },
    ]);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  if (model.startsWith("gemini/")) {
    const key = geminiKey(config);
    if (key === null) {
      return NextResponse.json({ ok: false, error: "no Gemini API key is set" }, { status: 400 });
    }
    const result = await geminiChat(key, model, [{ role: "user", content: prompt }]);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  const key = openRouterKey(config);
  if (key === null) {
    return NextResponse.json({ ok: false, error: "no OpenRouter key is set" }, { status: 400 });
  }

  const result = await complete(key, model, prompt);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
