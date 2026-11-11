import { describe, expect, it } from "vitest";

import { complete, chatWithTools, listModels, type OpenRouterModel } from "@slate/shared";

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listModels", () => {
  it("maps the catalogue", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        data: [
          {
            id: "vendor/model",
            name: "Vendor Model",
            context_length: 128000,
            pricing: { prompt: "0.000002", completion: "0.000004" },
          },
        ],
      })) as unknown as typeof fetch;

    const models: OpenRouterModel[] = await listModels(fetchImpl);
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("vendor/model");
    expect(models[0]?.contextLength).toBe(128000);
    expect(models[0]?.promptPrice).toBeCloseTo(0.000002);
  });

  it("skips rows without an id", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ data: [{ name: "broken" }, { id: "ok/model" }] })) as unknown as typeof fetch;
    const models = await listModels(fetchImpl);
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("ok/model");
  });

  it("throws when the endpoint fails", async () => {
    const fetchImpl = (async () => fakeResponse({}, false, 503)) as unknown as typeof fetch;
    await expect(listModels(fetchImpl)).rejects.toThrow(/503/);
  });
});

describe("complete", () => {
  it("returns the reply and the token counts", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        choices: [{ message: { content: "connected." } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      })) as unknown as typeof fetch;

    const result = await complete("sk-or-v1-test", "vendor/model", "hello", fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("connected.");
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(3);
  });

  it("reports an error instead of throwing", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ error: "no credit" }, false, 402)) as unknown as typeof fetch;
    const result = await complete("sk-or-v1-test", "vendor/model", "hello", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("402");
  });

  it("reports a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await complete("sk-or-v1-test", "vendor/model", "hello", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("offline");
  });
});

describe("chatWithTools", () => {
  it("returns a tool call with parsed arguments", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "update_plan",
                    arguments: '{"project":"demo","milestone":"M1"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      })) as unknown as typeof fetch;

    const result = await chatWithTools(
      "sk-or-v1-test",
      "vendor/model",
      [{ role: "user", content: "set the milestone" }],
      [
        {
          type: "function",
          function: {
            name: "update_plan",
            description: "update a plan",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.promptTokens).toBe(30);
    expect(result.message?.tool_calls).toHaveLength(1);
    expect(result.message?.tool_calls?.[0]?.function.name).toBe("update_plan");
    expect(JSON.parse(result.message?.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({
      project: "demo",
      milestone: "M1",
    });
  });

  it("survives a malformed tool call", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        choices: [
          {
            message: {
              content: "no tools for this one",
              tool_calls: [{ id: "", function: { name: "" } }],
            },
            finish_reason: "stop",
          },
        ],
      })) as unknown as typeof fetch;

    const result = await chatWithTools(
      "sk-or-v1-test",
      "vendor/model",
      [{ role: "user", content: "hello" }],
      [],
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(result.message?.tool_calls).toBeUndefined();
    expect(result.message?.content).toBe("no tools for this one");
  });

  it("reports an OpenRouter error", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ error: "no such model" }, false, 404)) as unknown as typeof fetch;
    const result = await chatWithTools(
      "sk-or-v1-test",
      "vendor/model",
      [{ role: "user", content: "hello" }],
      [],
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });
});
