import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "@/lib/agent";
import type { AgentToolContext } from "@/lib/agent-tools";

let root: string;
let context: AgentToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-agent-loop-"));
  context = { root, agent: "test-agent" };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return response({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  });
}

function reply(text: string) {
  return response({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 20 },
  });
}

function fakeFetch(responses: Response[]) {
  const requests: { messages?: { role?: string; tool_call_id?: string }[] }[] = [];
  const implementation = async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as (typeof requests)[number]);
    const next = responses.shift();
    if (next === undefined) throw new Error("no fake response left");
    return next;
  };
  return { implementation: implementation as unknown as typeof fetch, requests };
}

describe("runAgent", () => {
  it("executes a tool, feeds the result back, and returns the final reply", async () => {
    const fake = fakeFetch([
      toolCall("call_1", "create_project", {
        name: "Loop Test",
        goal: "Prove the loop works.",
      }),
      reply("Created the project."),
    ]);

    const result = await runAgent({
      apiKey: "sk-or-v1-test",
      model: "vendor/model",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "create it" }],
      context,
      fetchImpl: fake.implementation,
    });

    expect(result.ok).toBe(true);
    expect(result.reply).toBe("Created the project.");
    expect(result.actions).toEqual([{ ok: true, summary: "Created loop-test" }]);
    expect(existsSync(join(root, "loop-test", "README.md"))).toBe(true);

    const secondRequest = fake.requests[1];
    const toolMessage = secondRequest?.messages?.find((message) => message.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_1");
  });

  it("reports actions when the model fails after a successful write", async () => {
    const fake = fakeFetch([
      toolCall("call_1", "create_project", { name: "Partial Test" }),
      response({ error: "rate limited" }, false, 429),
    ]);

    const result = await runAgent({
      apiKey: "sk-or-v1-test",
      model: "vendor/model",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "create it" }],
      context,
      fetchImpl: fake.implementation,
    });

    expect(result.ok).toBe(true);
    expect(result.actions).toEqual([{ ok: true, summary: "Created partial-test" }]);
    expect(result.reply).toContain("could not finish");
    expect(result.error).toContain("429");
    expect(existsSync(join(root, "partial-test", "README.md"))).toBe(true);
  });

  it("marks a failed tool call as failed", async () => {
    const fake = fakeFetch([
      toolCall("call_1", "update_plan", {
        project: "missing",
        milestone: "M1",
      }),
      reply("I could not find that project."),
    ]);

    const result = await runAgent({
      apiKey: "sk-or-v1-test",
      model: "vendor/model",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "set the milestone" }],
      context,
      fetchImpl: fake.implementation,
    });

    expect(result.ok).toBe(true);
    expect(result.actions[0]?.ok).toBe(false);
    expect(result.actions[0]?.summary).toContain("Failed:");
  });
});
