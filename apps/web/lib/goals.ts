/**
 * Goals are Slate's own per-project checklist (`goals.json`), separate from the agent-owned
 * README plan. The implementations live in `@slate/agent-tools` so the OpenCode MCP server and the
 * web API share one copy; this module keeps the short `@/lib/...` path the app already uses.
 */

export * from "@slate/agent-tools/goals";
