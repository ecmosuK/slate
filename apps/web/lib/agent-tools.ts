/**
 * The tools Slate's agent can call.
 *
 * The implementations live in `@slate/agent-tools` so the OpenCode MCP server can expose them to
 * the single agent that runs inside a project folder; this module keeps the short `@/lib/...`
 * path the web app already uses.
 */

export * from "@slate/agent-tools";
