/**
 * A minimal MCP (Model Context Protocol) server speaking JSON-RPC over stdio, exposing Slate's
 * project/plan/goal tools to the opencode agent that is running inside a project folder.
 *
 * opencode starts local MCP servers before a run and connects them, so the same agent that edits
 * code can also maintain the plan block and the goals checklist. The project scope comes from the
 * SLATE_PROJECT / SLATE_MCP_FOLDER environment variables the run sets.
 */

import { createInterface } from "node:readline";

import { AGENT_TOOLS, executeAgentTool, type AgentToolContext } from "./tools.ts";

const SERVER_NAME = "slate-agent-tools";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

function context(): AgentToolContext {
  const folder = process.env.SLATE_MCP_FOLDER ?? process.env.SLATE_PROJECT ?? "";
  const project = process.env.SLATE_PROJECT ?? "";
  return {
    root: process.env.SLATE_ROOT ?? ".",
    agent: process.env.SLATE_AGENT ?? "slate-agent",
    project: project === "" ? null : project,
    folder: folder === "" ? null : folder,
  };
}

function respond(id: number | null, result: unknown): void {
  if (id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function handle(message: {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  const method = message.method ?? "";
  const params = (message.params ?? {}) as Record<string, unknown>;
  const id = typeof message.id === "number" ? message.id : null;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, {
        tools: AGENT_TOOLS.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: (tool.function.parameters ?? { type: "object" }) as Record<string, unknown>,
        })),
      });
      return;
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const outcome = await executeAgentTool(
        name,
        JSON.stringify(args ?? {}),
        context(),
        AGENT_TOOLS.map((tool) => tool.function.name),
      );
      respond(id, {
        content: [{ type: "text", text: outcome.content }],
        isError: !outcome.ok,
      });
      return;
    }
    default:
      // Unknown methods: acknowledge so the client is not left hanging.
      respond(id, null);
  }
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(trimmed) as typeof message;
  } catch {
    return;
  }
  void handle(message);
});
reader.on("close", () => {
  process.exit(0);
});
