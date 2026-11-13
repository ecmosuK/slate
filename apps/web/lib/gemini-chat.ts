import type {
  AgentCompletionResult,
  AgentMessage,
  ChatTool,
  ChatToolCall,
  ChatTurn,
  CompletionResult,
} from "@slate/shared";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

function normaliseToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") return;
    const row = entry as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown; [key: string]: unknown };
      [key: string]: unknown;
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

    // Preserve provider-specific fields (e.g. Gemini thought_signature) by keeping the raw entry.
    const preserved: any = { ...row };
    preserved.id = typeof row.id === "string" && row.id !== "" ? row.id : `call_${index}`;
    preserved.type = "function";
    preserved.function = {
      ...(row.function && typeof row.function === "object" ? row.function : {}),
      name,
      arguments: args,
    };
    calls.push(preserved as ChatToolCall);
  });
  return calls;
}

function toGeminiModel(model: string): string {
  return model.startsWith("gemini/") ? model.slice("gemini/".length) : model;
}

export async function geminiChat(
  apiKey: string,
  model: string,
  messages: ChatTurn[],
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  try {
    const response = await fetchImpl(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: toGeminiModel(model),
        messages,
        max_tokens: 2048,
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
      promptTokens: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
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

export async function geminiChatWithTools(
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools: ChatTool[],
  fetchImpl: typeof fetch = fetch,
): Promise<AgentCompletionResult> {
  try {
    const response = await fetchImpl(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: toGeminiModel(model),
        messages,
        max_tokens: 2048,
        tools,
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
        message?: { role?: unknown; content?: unknown; tool_calls?: unknown };
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
        error: "Gemini returned no message",
      };
    }

    const toolCalls = normaliseToolCalls(raw.tool_calls);
    const content = typeof raw.content === "string" ? raw.content : null;
    // Preserve raw message fields (e.g. thought signatures / provider metadata) for Gemini tool-calling.
    const message: AgentMessage = {
      ...(raw as Record<string, unknown>),
      role: "assistant",
      content: toolCalls.length > 0 ? (content ?? "") : content,
    } as AgentMessage;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    } else {
      delete (message as any).tool_calls;
    }

    return {
      ok: true,
      message,
      model,
      promptTokens: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
      completionTokens:
        typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
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