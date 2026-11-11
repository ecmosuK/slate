"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: AgentAction[];
}

interface AgentAction {
  ok: boolean;
  summary: string;
}

interface Model {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  source?: "openrouter" | "opencode";
  tools?: boolean | null;
}

interface Settings {
  hasKey: boolean;
  defaultModel: string | null;
}

interface ChatReply {
  ok: boolean;
  reply?: string;
  model?: string;
  actions?: AgentAction[];
  error?: string;
}

function priceLabel(model: Model): string {
  const value = model.promptPrice;
  if (value === 0 || model.id.endsWith(":free") || model.id === "openrouter/free") return "free";
  if (value === null) return "";
  const perMillion = value * 1_000_000;
  if (perMillion < 0.01) return "$0/M";
  return `$${perMillion.toFixed(perMillion < 1 ? 3 : 2)}/M`;
}

export default function Chat({ project = null }: { project?: string | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [hasKey, setHasKey] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [modelsResponse, configResponse] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/config"),
        ]);
        const catalogue = (await modelsResponse.json()) as { ok: boolean; models?: Model[] };
        const config = (await configResponse.json()) as Settings;
        if (cancelled) return;
        const list = catalogue.ok ? (catalogue.models ?? []) : [];
        setModels(list);
        setHasKey(config.hasKey);
        setModel((current) => {
          if (current !== "") return current;
          if (config.defaultModel !== null && config.defaultModel !== "") return config.defaultModel;
          return list[0]?.id ?? "";
        });
      } catch {
        if (!cancelled) setError("Could not load the model list.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (prompt === "" || loading) return;
    if (model === "") {
      setError("Choose a model first, or set a default in Settings.");
      return;
    }

    const nextMessages: Message[] = [...messages, { role: "user", content: prompt }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          project,
        }),
      });
      const body = (await response.json()) as ChatReply;
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `The agent returned ${response.status}`);
      }
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: body.reply ?? "",
          actions: body.actions ?? [],
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // Leave the user's message visible so they can retry.
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-container">
      <div className="chat-toolbar">
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          aria-label="Model"
          disabled={loading || models.length === 0}
        >
          {models.length === 0 && <option value="">loading models…</option>}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.source === "opencode" ? "[opencode] " : ""}
              {entry.name}
              {` · ${priceLabel(entry)}`}
            </option>
          ))}
        </select>
        <span className="meta">
          {project !== null ? `project context: ${project}` : "whole workspace"} · free models only · auto-fallback on rate limits
        </span>
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setError(null);
          }}
          disabled={loading || messages.length === 0}
        >
          Clear
        </button>
      </div>

      {!hasKey && (
        <p className="notice bad">
          No OpenRouter key yet. <Link href="/settings">Add one in Settings</Link>.
        </p>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            <p>Ask the agent to create a project, set a milestone, add goals, or plan the next task.</p>
            <p className="meta">
              Free models only. If a model is rate-limited, Slate tries another free OpenRouter model
              automatically. Chat tools work with OpenRouter models (opencode-provider models are
              listed for reference).
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            <div className="chat-role">{message.role === "user" ? "You" : "Slate"}</div>
            <div className="chat-content">{message.content}</div>
            {message.actions !== undefined && message.actions.length > 0 && (
              <ul className="chat-actions">
                {message.actions.map((action, actionIndex) => (
                  <li
                    className={action.ok ? "ok" : "bad"}
                    key={`${action.summary}-${actionIndex}`}
                  >
                    {action.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-message assistant">
            <div className="chat-role">Slate</div>
            <div className="chat-content meta">thinking…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="chat-form" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(event);
            }
          }}
          placeholder="Ask the agent…"
          rows={3}
          disabled={loading}
        />
        <div className="row">
          <button type="submit" className="primary" disabled={loading || input.trim() === ""}>
            {loading ? "Sending…" : "Send"}
          </button>
          <span className="meta">Enter sends · Shift+Enter makes a new line</span>
        </div>
      </form>

      {error !== null && <p className="notice bad">{error}</p>}
    </div>
  );
}
