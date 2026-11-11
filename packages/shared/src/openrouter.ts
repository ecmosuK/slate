/**
 * A thin OpenRouter client.
 *
 * OpenRouter is one key that reaches most model providers, which is what makes it useful for a
 * personal setup: no provider-specific accounts, one place to cap spending, and a model list that
 * changes without a code change.
 *
 * The key is only ever read on the server. It is never sent to a browser.
 */

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** Price per token, in the provider's own units (usually USD per token). */
  promptPrice: number | null;
  completionPrice: number | null;
}

export interface CompletionResult {
  ok: boolean;
  reply: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
}

function price(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Every model OpenRouter currently offers. The endpoint is public; no key needed. */
export async function listModels(
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterModel[]> {
  const response = await fetchImpl(`${OPENROUTER_BASE}/models`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${response.status}`);
  }
  const body = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(body.data) ? body.data : [];

  return rows
    .map((row) => {
      const item = row as {
        id?: unknown;
        name?: unknown;
        context_length?: unknown;
        pricing?: { prompt?: unknown; completion?: unknown };
      };
      if (typeof item.id !== "string") return null;
      return {
        id: item.id,
        name: typeof item.name === "string" ? item.name : item.id,
        contextLength: typeof item.context_length === "number" ? item.context_length : null,
        promptPrice: price(item.pricing?.prompt),
        completionPrice: price(item.pricing?.completion),
      };
    })
    .filter((model): model is OpenRouterModel => model !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

async function sendMessages(
  apiKey: string,
  model: string,
  messages: ChatTurn[],
  maxTokens: number,
  fetchImpl: typeof fetch,
): Promise<CompletionResult> {
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Slate",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return {
        ok: false,
        reply: "",
        model,
        promptTokens: null,
        completionTokens: null,
        error: `${response.status}: ${detail.slice(0, 300)}`,
      };
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = body.choices?.[0]?.message?.content;

    return {
      ok: true,
      reply: typeof content === "string" ? content : "",
      model,
      promptTokens:
        typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
      completionTokens:
        typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      reply: "",
      model,
      promptTokens: null,
      completionTokens: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Send one small message, to prove the key and the model work. */
export async function complete(
  apiKey: string,
  model: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  return sendMessages(apiKey, model, [{ role: "user", content: message }], 64, fetchImpl);
}

/** A longer, multi-turn conversation for the in-app agent. */
export async function chat(
  apiKey: string,
  model: string,
  messages: ChatTurn[],
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  return sendMessages(apiKey, model, messages, 2048, fetchImpl);
}
