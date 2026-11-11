/**
 * The chat agent loop.
 *
 * The model may ask for several tools in one turn. Execute them in order, feed each result back,
 * and stop when it answers with text. A model that cannot call tools still gets one plain-chat
 * fallback so the page keeps working.
 */

import {
  chat,
  chatWithTools,
  type AgentMessage,
  type ChatTurn,
} from "@slate/shared";

import {
  AGENT_TOOLS,
  executeAgentTool,
  type AgentToolContext,
} from "@/lib/agent-tools";
import { isRateLimitError } from "@/lib/free-models";

const MAX_STEPS = 8;

export interface AgentAction {
  ok: boolean;
  summary: string;
}

export interface AgentRequest {
  apiKey: string;
  model: string;
  /** Other OpenRouter model IDs to try if the primary model is rate-limited before any actions run. */
  fallbackModels?: string[];
  system: string;
  messages: ChatTurn[];
  context: AgentToolContext;
  /** Injected by tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AgentResult {
  ok: boolean;
  reply: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  actions: AgentAction[];
  error: string | null;
}

function plainMessages(system: string, messages: ChatTurn[]): ChatTurn[] {
  return [
    {
      role: "system",
      content: `${system}\n\nTool calling is unavailable for this model. Answer in plain text and describe any changes the user should make.`,
    },
    ...messages.filter((turn) => turn.role !== "system"),
  ];
}

async function runWithModel(
  request: AgentRequest,
  model: string,
): Promise<AgentResult> {
  const conversation: AgentMessage[] = [
    { role: "system", content: request.system },
    ...request.messages
      .filter((turn) => turn.role !== "system")
      .map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  const actions: AgentAction[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await chatWithTools(
      request.apiKey,
      model,
      conversation,
      AGENT_TOOLS,
      request.fetchImpl,
    );

    if (!result.ok) {
      // Some OpenRouter models do not expose function calling. Keep the chat usable.
      if (step === 0) {
        const fallback = await chat(
          request.apiKey,
          model,
          plainMessages(request.system, request.messages),
          request.fetchImpl,
        );
        if (fallback.ok) {
          return {
            ok: true,
            reply: fallback.reply,
            model: fallback.model ?? model,
            promptTokens: fallback.promptTokens,
            completionTokens: fallback.completionTokens,
            actions,
            error: null,
          };
        }
        return {
          ok: false,
          reply: "",
          model: fallback.model ?? model,
          promptTokens: fallback.promptTokens,
          completionTokens: fallback.completionTokens,
          actions,
          error: fallback.error ?? result.error,
        };
      }

      return {
        ok: actions.length > 0,
        reply:
          actions.length > 0
            ? `I made some changes, but could not finish: ${result.error ?? "the model stopped responding"}. Check the affected project and try again.`
            : "",
        model,
        promptTokens: promptTokens === 0 ? null : promptTokens,
        completionTokens: completionTokens === 0 ? null : completionTokens,
        actions,
        error: result.error,
      };
    }

    promptTokens += result.promptTokens ?? 0;
    completionTokens += result.completionTokens ?? 0;

    const message = result.message;
    if (message === null) {
      return {
        ok: false,
        reply: "",
        model: result.model ?? model,
        promptTokens: promptTokens === 0 ? null : promptTokens,
        completionTokens: completionTokens === 0 ? null : completionTokens,
        actions,
        error: "the agent returned no message",
      };
    }

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const reply = (message.content ?? "").trim();
      if (reply === "") {
        return {
          ok: false,
          reply: "",
          model: result.model ?? model,
          promptTokens: promptTokens === 0 ? null : promptTokens,
          completionTokens: completionTokens === 0 ? null : completionTokens,
          actions,
          error: "the agent returned an empty reply",
        };
      }

      return {
        ok: true,
        reply,
        model: result.model ?? model,
        promptTokens: promptTokens === 0 ? null : promptTokens,
        completionTokens: completionTokens === 0 ? null : completionTokens,
        actions,
        error: null,
      };
    }

    conversation.push(message);

    for (const call of calls) {
      const outcome = await executeAgentTool(
        call.function.name,
        call.function.arguments,
        request.context,
      );
      actions.push({ ok: outcome.ok, summary: outcome.summary });
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.content,
      });
    }
  }

  return {
    ok: actions.length > 0,
    reply:
      actions.length > 0
        ? `I made some changes, but stopped after ${MAX_STEPS} tool steps. Check the affected project before asking me to continue.`
        : "",
    model,
    promptTokens: promptTokens === 0 ? null : promptTokens,
    completionTokens: completionTokens === 0 ? null : completionTokens,
    actions,
    error: "the agent used too many tool steps without answering",
  };
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const candidates = [request.model, ...(request.fallbackModels ?? [])].filter(
    (value, index, all) => value !== "" && all.indexOf(value) === index,
  );
  let last: AgentResult | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    if (model === undefined) continue;
    const result = await runWithModel(request, model);
    if (result.ok) {
      if (index > 0) {
        const note = `Used fallback model ${model} after a rate limit.`;
        result.reply = result.reply === "" ? note : `${note}\n\n${result.reply}`;
      }
      return result;
    }

    last = result;
    // Only fall back when nothing was changed yet and the failure looks like a rate limit.
    if (result.actions.length > 0 || !isRateLimitError(result.error)) {
      return result;
    }
  }

  return (
    last ?? {
      ok: false,
      reply: "",
      model: request.model,
      promptTokens: null,
      completionTokens: null,
      actions: [],
      error: "no model was available",
    }
  );
}
