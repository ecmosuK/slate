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
  /** Where the model is called from: OpenRouter's API, or opencode's own provider. */
  source?: "openrouter" | "opencode";
  /** Whether the model advertises tool/function calling. */
  tools?: boolean | null;
}

/** A model is free when it costs nothing to call. */
export function isFreeModel(model: Pick<OpenRouterModel, "id" | "promptPrice" | "completionPrice">): boolean {
  if (model.promptPrice === 0 && model.completionPrice === 0) return true;
  if (model.id === "openrouter/free" || model.id.endsWith(":free")) return true;
  return false;
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
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
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
    .map((row): OpenRouterModel | null => {
      const item = row as {
        id?: unknown;
        name?: unknown;
        context_length?: unknown;
        pricing?: { prompt?: unknown; completion?: unknown };
        supported_parameters?: unknown;
      };
      if (typeof item.id !== "string") return null;
      const supported = Array.isArray(item.supported_parameters) ? item.supported_parameters : null;
      return {
        id: item.id,
        name: typeof item.name === "string" ? item.name : item.id,
        contextLength: typeof item.context_length === "number" ? item.context_length : null,
        promptPrice: price(item.pricing?.prompt),
        completionPrice: price(item.pricing?.completion),
        source: "openrouter",
        tools: supported === null ? null : supported.includes("tools"),
      };
    })
    .filter((model): model is OpenRouterModel => model !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One function call requested by the model. */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON text, as returned by the provider. */
    arguments: string;
  };
}

/** A tool the model is allowed to call. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A message in a tool-using conversation. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface AgentCompletionResult {
  ok: boolean;
  message: AgentMessage | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  error: string | null;
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

function normaliseToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];

  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") return;
    const row = entry as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = typeof row.function?.name === "string" ? row.function.name : "";
    if (name === "") return;

    let args = "{}";
    if (typeof row.function?.arguments === "string") {
      args = row.function.arguments;
    } else if (row.function?.arguments !== undefined) {
      try {
        args = JSON.stringify(row.function.arguments);
      } catch {
        args = "{}";
      }
    }

    calls.push({
      id: typeof row.id === "string" && row.id !== "" ? row.id : `call_${index}`,
      type: "function",
      function: { name, arguments: args },
    });
  });

  return calls;
}

/**
 * One completion that may ask to call tools.
 *
 * The caller owns the loop: execute each call, append a `tool` message with the matching
 * `tool_call_id`, and send the conversation again until the model answers with text.
 */
export async function chatWithTools(
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools: ChatTool[],
  fetchImpl: typeof fetch = fetch,
): Promise<AgentCompletionResult> {
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
        max_tokens: 2048,
        tools,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return {
        ok: false,
        message: null,
        model,
        promptTokens: null,
        completionTokens: null,
        finishReason: null,
        error: `${response.status}: ${detail.slice(0, 300)}`,
      };
    }

    const body = (await response.json()) as {
      choices?: {
        message?: {
          role?: unknown;
          content?: unknown;
          tool_calls?: unknown;
        };
        finish_reason?: unknown;
      }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };

    const choice = body.choices?.[0];
    const raw = choice?.message;
    if (raw === undefined || raw === null) {
      return {
        ok: false,
        message: null,
        model,
        promptTokens: null,
        completionTokens: null,
        finishReason: null,
        error: "OpenRouter returned no message",
      };
    }

    const toolCalls = normaliseToolCalls(raw.tool_calls);
    const message: AgentMessage = {
      role: "assistant",
      content: typeof raw.content === "string" ? raw.content : null,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
      ok: true,
      message,
      model,
      promptTokens:
        typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
      completionTokens:
        typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
      finishReason:
        typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      message: null,
      model,
      promptTokens: null,
      completionTokens: null,
      finishReason: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
