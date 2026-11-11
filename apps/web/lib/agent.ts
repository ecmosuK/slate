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

const MAX_STEPS = 8;

export interface AgentAction {
  ok: boolean;
  summary: string;
}

export interface AgentRequest {
  apiKey: string;
  model: string;
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

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
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
      request.model,
      conversation,
      AGENT_TOOLS,
      request.fetchImpl,
    );

    if (!result.ok) {
      // Some OpenRouter models do not expose function calling. Keep the chat usable.
      if (step === 0) {
        const fallback = await chat(
          request.apiKey,
          request.model,
          plainMessages(request.system, request.messages),
          request.fetchImpl,
        );
        return {
          ok: fallback.ok,
          reply: fallback.reply,
          model: fallback.model ?? request.model,
          promptTokens: fallback.promptTokens,
          completionTokens: fallback.completionTokens,
          actions,
          error: fallback.error,
        };
      }

      return {
        ok: actions.length > 0,
        reply:
          actions.length > 0
            ? `I made some changes, but could not finish: ${result.error ?? "the model stopped responding"}. Check the affected project and try again.`
            : "",
        model: request.model,
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
        model: result.model ?? request.model,
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
          model: result.model ?? request.model,
          promptTokens: promptTokens === 0 ? null : promptTokens,
          completionTokens: completionTokens === 0 ? null : completionTokens,
          actions,
          error: "the agent returned an empty reply",
        };
      }

      return {
        ok: true,
        reply,
        model: result.model ?? request.model,
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
    model: request.model,
    promptTokens: promptTokens === 0 ? null : promptTokens,
    completionTokens: completionTokens === 0 ? null : completionTokens,
    actions,
    error: "the agent used too many tool steps without answering",
  };
}
