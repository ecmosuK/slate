"use client";

import Link from "next/link";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { DEFAULT_CHAT_MODEL } from "@/lib/model-defaults";

interface ToolCard {
  id: string;
  tool: string;
  title: string;
  detail: string;
  status: "running" | "completed" | "error";
}

/** One event of the live turn. The shape matches the server's AgentEvent. */
type LiveEvent =
  | { type: "text"; id: string; text: string }
  | { type: "tool"; card: ToolCard }
  | { type: "cost"; micros: number }
  | { type: "context"; tokens: number }
  | { type: "error"; message: string }
  | { type: "done"; status: "succeeded" | "failed" | "cancelled"; error: string | null };

interface Message {
  role: "user" | "assistant";
  content: string;
  tools?: ToolCard[];
  costMicros?: number;
  status?: "succeeded" | "failed" | "cancelled";
  error?: string | null;
}

/** Plan and goal tools: a finished one means the page's tasks or goals may have changed. */
const PLAN_TOOLS = new Set([
  "list_projects",
  "read_project",
  "create_project",
  "update_plan",
  "add_tasks",
  "complete_task",
  "reorder_tasks",
  "move_task",
  "add_goal",
  "update_goal",
  "reorder_goals",
]);

function planToolNames(card: ToolCard): boolean {
  const name = card.tool.includes("__")
    ? card.tool.slice(card.tool.lastIndexOf("__") + 2)
    : card.tool;
  return PLAN_TOOLS.has(name);
}

function storageKey(project: string | null, suffix?: string): string {
  const base = `slate:chat:${project ?? "__workspace__"}`;
  return suffix ? `${base}:${suffix}` : base;
}

function loadMessages(project: string | null, suffix?: string): Message[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(project, suffix));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const row = item as {
        role?: unknown;
        content?: unknown;
        tools?: unknown;
        costMicros?: unknown;
        status?: unknown;
        error?: unknown;
      };
      if (row.role !== "user" && row.role !== "assistant") return [];
      if (typeof row.content !== "string") return [];
      const message: Message = { role: row.role, content: row.content };
      if (Array.isArray(row.tools)) {
        const tools = row.tools.flatMap((tool) => {
          if (tool === null || typeof tool !== "object") return [];
          const card = tool as Partial<ToolCard>;
          if (typeof card.id !== "string" || typeof card.tool !== "string") return [];
          return [
            {
              id: card.id,
              tool: card.tool,
              title: typeof card.title === "string" ? card.title : "",
              detail: typeof card.detail === "string" ? card.detail : "",
              status:
                card.status === "error"
                  ? ("error" as const)
                  : card.status === "running"
                    ? ("running" as const)
                    : ("completed" as const),
            },
          ];
        });
        if (tools.length > 0) message.tools = tools;
      }
      if (typeof row.costMicros === "number" && row.costMicros > 0) {
        message.costMicros = row.costMicros;
      }
      if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
        message.status = row.status;
      }
      if (typeof row.error === "string" && row.error !== "") message.error = row.error;
      return [message];
    });
  } catch {
    return [];
  }
}

function saveMessages(project: string | null, messages: Message[], suffix?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(project, suffix), JSON.stringify(messages));
  } catch {
    // ignore storage failures
  }
}

/**
 * Fold new events into the transcript.
 *
 * Text and tool events are keyed by their id: the same part updating (a tool moving from running
 * to completed) replaces itself where it stands, and new parts append. That keeps the order the
 * agent produced them in.
 */
function applyEvents(current: LiveEvent[], incoming: LiveEvent[]): LiveEvent[] {
  const events = [...current];
  for (const event of incoming) {
    if (event.type === "text") {
      const index = events.findIndex((entry) => entry.type === "text" && entry.id === event.id);
      if (index === -1) events.push(event);
      else events[index] = event;
      continue;
    }
    if (event.type === "tool") {
      const index = events.findIndex(
        (entry) => entry.type === "tool" && entry.card.id === event.card.id,
      );
      if (index === -1) events.push(event);
      else events[index] = event;
      continue;
    }
    if (event.type === "cost") {
      const index = events.findIndex((entry) => entry.type === "cost");
      if (index === -1) events.push(event);
      else events[index] = event;
      continue;
    }
    if (event.type === "context") {
      const index = events.findIndex((entry) => entry.type === "context");
      if (index === -1) events.push(event);
      else events[index] = event;
      continue;
    }
    if (event.type === "error") {
      const index = events.findIndex((entry) => entry.type === "error");
      if (index === -1) events.push(event);
      else events[index] = event;
      continue;
    }
    // done closes the turn; keep the last one.
    const index = events.findIndex((entry) => entry.type === "done");
    if (index === -1) events.push(event);
    else events[index] = event;
  }
  return events;
}

function textOf(events: LiveEvent[]): string {
  return events
    .filter((event): event is Extract<LiveEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("\n");
}

/** The plan agent's closing words: whatever it said after its last tool call. */
function finalTextOf(events: LiveEvent[]): string {
  let lastTool = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === "tool") lastTool = index;
  }
  const closing = events
    .slice(lastTool + 1)
    .filter((event): event is Extract<LiveEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("\n")
    .trim();
  return closing !== "" ? closing : textOf(events);
}

function toolsOf(events: LiveEvent[]): ToolCard[] {
  return events
    .filter((event): event is Extract<LiveEvent, { type: "tool" }> => event.type === "tool")
    .map((event) => event.card);
}

function costOf(events: LiveEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "cost") return event.micros;
  }
  return 0;
}

function contextOf(events: LiveEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "context") return event.tokens;
  }
  return 0;
}

function statusOf(events: LiveEvent[]): { status?: Message["status"]; error?: string | null } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "done") return { status: event.status, error: event.error };
  }
  return {};
}

function costLabel(micros: number): string {
  if (micros <= 0) return "free";
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

interface Model {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  source?: "openrouter" | "opencode" | "gemini";
  tools?: boolean | null;
  unavailableUntil?: number | null;
  unavailableReason?: string | null;
}

interface Settings {
  hasKey: boolean;
  hasGeminiKey?: boolean;
  defaultModel: string | null;
}

/** Plan/goal tools that change something; read-only calls leave the plan as it was. */
const PLAN_EDIT_TOOLS = new Set([
  "update_plan",
  "add_tasks",
  "complete_task",
  "reorder_tasks",
  "move_task",
  "add_goal",
  "update_goal",
  "reorder_goals",
]);

/** A plain-language fallback for a plan turn that ended with tool calls but no closing words. */
function planSummary(tools: ToolCard[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (tool.status !== "completed") continue;
    const name = tool.tool.includes("__") ? tool.tool.slice(tool.tool.lastIndexOf("__") + 2) : tool.tool;
    if (!PLAN_EDIT_TOOLS.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "Done. The plan and goals are up to date.";
  const phrases = [...counts].map(([name, count]) => {
    const one = count === 1;
    switch (name) {
      case "add_tasks":
        return one ? "added a task" : `added ${count} tasks`;
      case "complete_task":
        return one ? "completed a task" : `completed ${count} tasks`;
      case "reorder_tasks":
      case "move_task":
        return "reordered the tasks";
      case "add_goal":
        return one ? "added a goal" : `added ${count} goals`;
      case "update_goal":
        return one ? "updated a goal" : `updated ${count} goals`;
      case "reorder_goals":
        return "reordered the goals";
      default:
        return "updated the plan";
    }
  });
  return `Done — ${phrases.join(", ")}.`;
}

function priceLabel(model: Model): string {
  const value = model.promptPrice;
  if (value === 0 || model.id.endsWith(":free") || model.id === "openrouter/free") return "free";
  if (value === null) return "";
  const perMillion = value * 1_000_000;
  if (perMillion < 0.01) return "$0/M";
  return `$${perMillion.toFixed(perMillion < 1 ? 3 : 2)}/M`;
}

export interface ChatHandle {
  sendPrompt: (text: string) => Promise<void>;
}

interface ChatProps {
  project?: string | null;
  mode?: "default" | "goals";
  storageKeySuffix?: string;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  emptyTitle?: string;
  emptyBody?: string;
  /** Called after a turn that changed something, so the page can re-read tasks and goals. */
  onChanged?: () => void;
}

const Chat = forwardRef<ChatHandle, ChatProps>(function Chat(
  {
    project = null,
    mode = "default",
    storageKeySuffix,
    title,
    subtitle,
    placeholder = "Ask the agent…",
    emptyTitle = "Ask the agent to build something, change a file, or plan the next task.",
    emptyBody = "This agent runs in the project's own folder with the full toolset — reading and editing files, running commands — plus Slate's plan and goal tools. Free models only: the one you pick is the one that runs.",
    onChanged,
  },
  ref,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<LiveEvent[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [hasKey, setHasKey] = useState(true);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(80_000);
  const endRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef<LiveEvent[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const loading = runId !== null;
  const planAgent = mode === "goals";

  useEffect(() => {
    setMessages(loadMessages(project, storageKeySuffix));
    setEvents([]);
    setRunId(null);
    setHydrated(true);
    closeStream();
    // A turn that was running when the page reloaded is re-joined below.
    return () => closeStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, storageKeySuffix]);

  function setEvents(next: LiveEvent[]): void {
    eventsRef.current = next;
    setLive(next);
  }

  function closeStream(): void {
    if (sourceRef.current !== null) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }

  useEffect(() => {
    if (!hydrated) return;
    saveMessages(project, messages, storageKeySuffix);
  }, [project, messages, hydrated, storageKeySuffix]);

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
        setHasGeminiKey(config.hasGeminiKey === true);
        setModel((current) => {
          if (current !== "") return current;
          if (config.defaultModel !== null && config.defaultModel !== "") return config.defaultModel;
          if (list.some((entry) => entry.id === DEFAULT_CHAT_MODEL)) return DEFAULT_CHAT_MODEL;
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

  // Rejoin a turn that is still running in the background after a reload.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/agent?project=${encodeURIComponent(project ?? "")}`,
        );
        const body = (await response.json()) as {
          ok: boolean;
          run?: {
            id: string;
            status: string;
            contextTokens?: number;
            events?: LiveEvent[];
          } | null;
          session?: { contextTokens?: number; limitTokens?: number };
        };
        if (cancelled || !body.ok) return;
        if (typeof body.session?.contextTokens === "number") {
          setContextTokens(body.session.contextTokens);
        }
        if (typeof body.session?.limitTokens === "number" && body.session.limitTokens > 0) {
          setContextLimit(body.session.limitTokens);
        }
        if (body.run === null || body.run === undefined) return;
        if (typeof body.run.contextTokens === "number" && body.run.contextTokens > 0) {
          setContextTokens(body.run.contextTokens);
        }
        if (body.run.status !== "running") return;
        if (body.run.events !== undefined) setEvents(body.run.events);
        attach(body.run.id);
      } catch {
        // A rejoin that fails only costs the tail of a turn.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, project]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, live]);

  useEffect(() => {
    const tokens = contextOf(live);
    if (tokens > 0) setContextTokens(tokens);
  }, [live]);

  function finishTurn(): void {
    const events = eventsRef.current;
    const { status, error: runError } = statusOf(events);
    const tools = toolsOf(events);
    const costMicros = costOf(events);
    const spoken = planAgent ? finalTextOf(events) : textOf(events);
    // The plan agent answers in plain language: no tool cards and no cost line in its chat.
    const content = spoken !== "" || !planAgent ? spoken : planSummary(tools);

    closeStream();
    setRunId(null);

    if (tools.length > 0 || content !== "" || status !== undefined) {
      const message: Message = {
        role: "assistant",
        content,
        tools: !planAgent && tools.length > 0 ? tools : undefined,
        costMicros: !planAgent && costMicros > 0 ? costMicros : undefined,
        status,
        error: runError ?? null,
      };
      setMessages((current) => [...current, message]);
    }
    setEvents([]);

    if (tools.some((tool) => tool.status === "completed" && planToolNames(tool))) {
      onChangedRef.current?.();
    }
    if (status === "failed" && runError != null && runError !== "") {
      // The server rotated the session because it overflowed; show the fresh size.
      if (/new session was started/i.test(runError)) setContextTokens(0);
      setError(runError);
    }
  }

  function attach(id: string): void {
    setRunId(id);
    const source = new EventSource(`/api/agent/stream?run=${encodeURIComponent(id)}`);
    sourceRef.current = source;

    const read = (event: MessageEvent, apply: (data: unknown) => void): void => {
      try {
        apply(JSON.parse(event.data as string));
      } catch {
        // A malformed frame is dropped rather than breaking the turn.
      }
    };

    source.addEventListener("snapshot", (event) =>
      read(event, (data) => {
        const payload = data as { events?: LiveEvent[] };
        if (Array.isArray(payload.events)) setEvents(payload.events);
      }),
    );
    source.addEventListener("event", (event) =>
      read(event, (data) => {
        if (data !== null && typeof data === "object") {
          setEvents(applyEvents(eventsRef.current, [data as LiveEvent]));
        }
      }),
    );
    source.addEventListener("done", (event) =>
      read(event, (data) => {
        const payload = data as { status?: string; error?: string | null };
        const status =
          payload.status === "failed" || payload.status === "cancelled"
            ? payload.status
            : "succeeded";
        setEvents(
          applyEvents(eventsRef.current, [
            { type: "done", status, error: payload.error ?? null },
          ]),
        );
        finishTurn();
      }),
    );
    source.addEventListener("error", () => {
      // EventSource retries on its own; the server closes the stream when the turn ends, which
      // arrives as a done event first. If the connection is simply gone, stop the turn here.
      if (source.readyState === EventSource.CLOSED) {
        finishTurn();
      }
    });
  }

  async function sendPrompt(prompt: string) {
    const text = prompt.trim();
    if (text === "" || loading) return;
    if (model === "") {
      setError("Choose a model first, or set a default in Settings.");
      return;
    }

    setMessages((current) => [...current, { role: "user", content: text }]);
    setInput("");
    setEvents([]);
    setError(null);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          prompt: text,
          model,
          focus: mode === "goals" ? "goals" : "chat",
        }),
      });
      const body = (await response.json()) as { ok: boolean; run?: { id: string }; error?: string };
      if (!response.ok || !body.ok || body.run === undefined) {
        throw new Error(body.error ?? `The agent returned ${response.status}`);
      }
      attach(body.run.id);
    } catch (caught) {
      setRunId(null);
      setError(caught instanceof Error ? caught.message : String(caught));
      // Leave the user's message visible so they can retry.
    }
  }

  async function stopTurn() {
    if (runId === null) return;
    try {
      await fetch("/api/agent/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run: runId }),
      });
    } catch {
      // The stream's done event closes the turn even if this request failed.
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await sendPrompt(input);
  }

  function clearChat(): void {
    setMessages([]);
    setError(null);
    setEvents([]);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKey(project, storageKeySuffix));
      } catch {
        // ignore
      }
    }
  }

  async function newSession(): Promise<void> {
    if (loading) return;
    try {
      const response = await fetch(`/api/agent?project=${encodeURIComponent(project ?? "")}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `The agent returned ${response.status}`);
      }
      clearChat();
      setContextTokens(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useImperativeHandle(ref, () => ({ sendPrompt }));

  const liveTools = toolsOf(live);
  const liveText = textOf(live);
  const liveCost = costOf(live);

  return (
    <div className="chat-container">
      {title !== undefined && <h3 className="chat-title">{title}</h3>}
      {subtitle !== undefined && <p className="meta">{subtitle}</p>}
      <div className="chat-toolbar">
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          aria-label="Model"
          disabled={loading || models.length === 0}
        >
          {models.length === 0 && <option value="">loading models…</option>}
          {models.map((entry) => {
            const unavailable =
              typeof entry.unavailableUntil === "number" && entry.unavailableUntil > Date.now();
            return (
              <option key={entry.id} value={entry.id} disabled={unavailable}>
                {entry.source === "opencode" ? "[opencode] " : entry.source === "gemini" ? "[gemini] " : ""}
                {entry.name}
                {` · ${priceLabel(entry)}`}
                {unavailable ? " · free limit reached" : ""}
              </option>
            );
          })}
        </select>
        <span className="meta">
          {project !== null ? `working in: ${project}` : "whole workspace"} ·{" "}
          {mode === "goals" ? "plan agent (goals and tasks)" : "one agent, full tools"}
          {contextTokens > 0
            ? ` · session context ~${Math.max(1, Math.round(contextTokens / 1000))}k tokens`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => void newSession()}
          disabled={loading}
          title={`Start a fresh conversation. Sessions rotate automatically above ~${Math.round(
            contextLimit / 1000,
          )}k tokens, so a long transcript never becomes one giant prompt.`}
        >
          New session
        </button>
        <button type="button" onClick={clearChat} disabled={loading || messages.length === 0}>
          Clear
        </button>
      </div>

      {!hasKey && !hasGeminiKey && (
        <p className="notice bad">
          No API key yet. <Link href="/settings">Add an OpenRouter or Gemini key in Settings</Link>.
        </p>
      )}
      {model.startsWith("gemini/") && !hasGeminiKey && (
        <p className="notice bad">
          No Gemini key yet. <Link href="/settings">Add a Gemini key in Settings</Link>.
        </p>
      )}
      {model !== "" && !model.startsWith("gemini/") && !model.startsWith("opencode/") && !hasKey && (
        <p className="notice bad">
          No OpenRouter key yet. <Link href="/settings">Add an OpenRouter key in Settings</Link>.
        </p>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            <p>{emptyTitle}</p>
            <p className="meta">{emptyBody}</p>
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            <div className="chat-role">{message.role === "user" ? "You" : "Slate"}</div>
            {message.content !== "" && <div className="chat-content">{message.content}</div>}
            {!planAgent && message.tools !== undefined && message.tools.length > 0 && (
              <ul className="chat-tools">
                {message.tools.map((tool) => (
                  <li
                    className={tool.status === "error" ? "bad" : tool.status === "running" ? "running" : ""}
                    key={tool.id}
                  >
                    <span className="chat-tool-name">{tool.tool}</span>
                    {tool.title !== "" && <span className="chat-tool-title">{tool.title}</span>}
                    {tool.detail !== "" && <span className="chat-tool-detail">{tool.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
            {message.status === "cancelled" && (
              <p className="meta">stopped before it finished</p>
            )}
            {message.error !== undefined && message.error !== null && message.error !== "" && (
              <p className="notice bad">{message.error}</p>
            )}
            {!planAgent && message.costMicros !== undefined && (
              <p className="meta chat-cost">cost {costLabel(message.costMicros)}</p>
            )}
          </div>
        ))}

        {loading && (
          <div className="chat-message assistant">
            <div className="chat-role">Slate</div>
            {liveText !== "" && <div className="chat-content">{liveText}</div>}
            {planAgent ? (
              liveText === "" && <div className="chat-content meta">working on the plan…</div>
            ) : (
              <>
                {liveTools.length > 0 && (
                  <ul className="chat-tools">
                    {liveTools.map((tool) => (
                      <li
                        className={tool.status === "error" ? "bad" : tool.status === "running" ? "running" : ""}
                        key={tool.id}
                      >
                        <span className="chat-tool-name">{tool.tool}</span>
                        {tool.title !== "" && <span className="chat-tool-title">{tool.title}</span>}
                        {tool.detail !== "" && <span className="chat-tool-detail">{tool.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {liveText === "" && liveTools.length === 0 && (
                  <div className="chat-content meta">thinking…</div>
                )}
                <p className="meta chat-cost">
                  working… {liveCost > 0 ? `· ${costLabel(liveCost)}` : ""}
                </p>
              </>
            )}
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
          placeholder={placeholder}
          rows={3}
          disabled={loading}
        />
        <div className="row">
          <button type="submit" className="primary" disabled={loading || input.trim() === ""}>
            {loading ? "Working…" : "Send"}
          </button>
          {loading && (
            <button type="button" onClick={() => void stopTurn()}>
              Stop
            </button>
          )}
          <span className="meta">Enter sends · Shift+Enter makes a new line</span>
        </div>
      </form>

      {error !== null && <p className="notice bad">{error}</p>}
    </div>
  );
});

export default Chat;
