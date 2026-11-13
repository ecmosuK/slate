import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentRunError,
  buildPrompt,
  clearStoredSessionId,
  contextQuotaMessage,
  getAgentRun,
  isContextQuotaError,
  isPlanTool,
  lastContextTokens,
  latestAgentRun,
  modelUnavailabilityOf,
  parseAgentLine,
  setAgentBinaryResolver,
  setAgentFolderResolver,
  setAgentKill,
  setAgentRootResolver,
  setAgentSpawn,
  startAgentTurn,
  stopAgentRun,
  storedSessionId,
  type AgentSpawn,
  type AgentEvent,
} from "@/lib/agent-session";

/** A stand-in for a spawned opencode process. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 2468;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Feed one line of `--format json` output to the run. */
  write(line: unknown): void {
    this.stdout.write(`${JSON.stringify(line)}\n`);
  }

  /** Pretend the process finished. */
  finish(code: number | null = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

let root: string;
let sessionsFile: string;
let counter = 0;
let spawned: FakeChild[];
let spawnCalls: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[];

/** The run store is global, so every test works in its own folder. */
function nextFolder(): string {
  counter += 1;
  const folder = join(root, `demo-${counter}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

function collect(runId: string): AgentEvent[] {
  return getAgentRun(runId)?.events ?? [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-agent-"));
  sessionsFile = join(root, "agent-sessions.json");
  process.env["SLATE_AGENT_SESSIONS"] = sessionsFile;
  process.env["SLATE_REPO_ROOT"] = root;
  spawned = [];
  spawnCalls = [];

  setAgentFolderResolver((slug) => join(root, slug));
  setAgentRootResolver(() => root);
  setAgentBinaryResolver(() => "/fake/opencode");

  const fakeSpawn: AgentSpawn = (command, args, options) => {
    spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    const child = new FakeChild();
    spawned.push(child);
    return child as unknown as ReturnType<AgentSpawn>;
  };
  setAgentSpawn(fakeSpawn);
  setAgentKill((child) => {
    if (child === null) return;
    const fake = child as unknown as FakeChild;
    fake.killed = true;
    fake.finish(null);
  });
});

afterEach(() => {
  setAgentSpawn(null);
  setAgentKill(null);
  setAgentBinaryResolver(null);
  setAgentFolderResolver(null);
  setAgentRootResolver(null);
  delete process.env["SLATE_AGENT_SESSIONS"];
  delete process.env["SLATE_REPO_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("parseAgentLine", () => {
  it("keeps text parts keyed by their id", () => {
    const line = JSON.stringify({
      type: "text",
      sessionID: "ses_abc",
      part: { id: "prt_1", text: "hello world" },
    });
    expect(parseAgentLine(line, 0)).toEqual({
      sessionId: "ses_abc",
      event: { type: "text", id: "prt_1", text: "hello world" },
      modelError: null,
    });
  });

  it("turns a tool call into a card with its title and status", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        id: "prt_tool",
        tool: "write",
        state: { status: "completed", input: { path: "/x/game.js" }, output: "wrote 10 bytes" },
      },
    });
    const { event } = parseAgentLine(line, 0);
    expect(event).toEqual({
      type: "tool",
      card: {
        id: "prt_tool",
        tool: "write",
        title: "/x/game.js",
        detail: "wrote 10 bytes",
        status: "completed",
      },
    });
  });

  it("marks a failed tool call as an error card", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { id: "prt_tool", tool: "bash", state: { status: "error", input: { command: "ls" }, error: "not found" } },
    });
    const { event } = parseAgentLine(line, 0);
    expect(event?.type).toBe("tool");
    expect(event?.type === "tool" && event.card.status).toBe("error");
    expect(event?.type === "tool" && event.card.detail).toBe("not found");
  });

  it("accumulates cost across steps", () => {
    const line = JSON.stringify({ type: "step_finish", part: { cost: 0.25 } });
    expect(parseAgentLine(line, 1_000_000).event).toEqual({ type: "cost", micros: 1_250_000 });
  });

  it("reports the request size from the step's token counts", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { cost: 0.25, tokens: { input: 1_000, cache: { read: 500 } } },
    });
    const result = parseAgentLine(line, 0);
    expect(result.event).toEqual({ type: "cost", micros: 250_000 });
    expect(result.contextTokens).toBe(1_500);
  });

  it("reports context for a free step too", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { cost: 0, tokens: { input: 400, cache: { read: 100 } } },
    });
    const result = parseAgentLine(line, 0);
    expect(result.event).toBeNull();
    expect(result.contextTokens).toBe(500);
  });

  it("ignores free steps, unknown events and non-JSON noise", () => {
    expect(parseAgentLine(JSON.stringify({ type: "step_finish", part: { cost: 0 } }), 5).event).toBeNull();
    expect(parseAgentLine(JSON.stringify({ type: "step_start", part: {} }), 5).event).toBeNull();
    expect(parseAgentLine("opencode v1.2.3", 5).event).toBeNull();
  });

  it("reports an error event's message", () => {
    const line = JSON.stringify({ type: "error", error: { message: "boom" } });
    expect(parseAgentLine(line, 0).event).toEqual({ type: "error", message: "boom" });
  });

  it("keeps a provider quota's retry window from the message", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        type: "provider.quota",
        message:
          "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 15.6s.",
      },
    });
    expect(parseAgentLine(line, 0).modelError).toEqual({
      type: "provider.quota",
      retryAfterMs: 15_600,
    });
  });
});

describe("context quota", () => {
  const message =
    "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.5-flash-lite. Please retry in 15.6s.";

  it("recognises a session-size quota, not a model-wide one", () => {
    expect(isContextQuotaError("provider.quota", message)).toBe(true);
    expect(isContextQuotaError("provider.rate-limit", "per minute limit exceeded")).toBe(true);
    expect(isContextQuotaError("provider.quota", "daily quota exhausted")).toBe(false);
    expect(isContextQuotaError("provider.free-limit", message)).toBe(false);
  });

  it("explains the limit without claiming the allowance is gone", () => {
    const translated = contextQuotaMessage(message, 480_000);
    expect(translated).toContain("about 480k tokens per request");
    expect(translated).toContain("250,000 input tokens per minute");
    expect(translated).toContain("not your allowance running out");
    expect(translated).toContain("retry in ~16s");
    expect(translated).toContain("new session was started");
  });
});

describe("buildPrompt", () => {
  it("keeps the project agent on the MCP tools for the two Slate files", () => {
    const prompt = buildPrompt("hi", "chat");
    expect(prompt).toContain("Slate's project agent");
    expect(prompt).toContain("update_plan");
    expect(prompt.trimEnd().endsWith("hi")).toBe(true);
  });

  it("holds the plan focus to goals and plan tasks", () => {
    const prompt = buildPrompt("hi", "goals");
    expect(prompt).toContain("Slate's plan agent");
    expect(prompt).toContain("Do not edit");
    expect(prompt).toContain("mark tasks complete");
    expect(prompt).toContain("reply in plain language");
    expect(prompt).toContain("Do not mention tool names");
  });
});

describe("isPlanTool", () => {
  it("recognises the MCP server's namespaced tool names", () => {
    expect(isPlanTool("mcp__slate__add_tasks")).toBe(true);
    expect(isPlanTool("update_goal")).toBe(true);
    expect(isPlanTool("write")).toBe(false);
  });
});

describe("startAgentTurn", () => {
  it("runs in the project folder with --auto and streams the transcript", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({
      project: "demo",
      folder,
      prompt: "hello",
      model: "opencode/some-free-model",
    });

    expect(run.status).toBe("running");
    expect(spawnCalls[0]?.cwd).toBe(folder);
    expect(spawnCalls[0]?.args).toContain("--auto");
    expect(spawnCalls[0]?.args).toContain("--format");
    // First run: no --session yet, the id comes back from the CLI.
    expect(spawnCalls[0]?.args).not.toContain("--session");

    // The slate MCP server reaches the run through the folder's own opencode config.
    const configPath = join(folder, ".opencode", "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp: { servers: Record<string, { command: string[]; environment: Record<string, string> }> };
    };
    expect(config.mcp.servers.slate?.command.join(" ")).toContain("mcp-server.ts");
    expect(config.mcp.servers.slate?.environment["SLATE_PROJECT"]).toBe("demo");

    const child = spawned[0];
    child?.write({ type: "text", sessionID: "ses_one", part: { id: "prt_a", text: "thinking" } });
    child?.write({
      type: "tool_use",
      sessionID: "ses_one",
      part: { id: "prt_b", tool: "write", state: { status: "completed", input: { path: "game.js" }, output: "ok" } },
    });
    child?.write({ type: "step_finish", sessionID: "ses_one", part: { cost: 0 } });
    child?.finish(0);

    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");

    const events = collect(run.id);
    expect(events.map((event) => event.type)).toEqual(["text", "tool", "done"]);
    expect(events[0]).toEqual({ type: "text", id: "prt_a", text: "thinking" });
    expect(getAgentRun(run.id)?.sessionId).toBe("ses_one");
    expect(storedSessionId(folder)).toBe("ses_one");
    expect(getAgentRun(run.id)?.prompt).toBe("hello");
  });

  it("remembers the session id so the next turn continues the conversation", async () => {
    const folder = nextFolder();
    const first = startAgentTurn({ project: "demo", folder, prompt: "one", model: "m/x" });
    spawned[0]?.write({ type: "text", sessionID: "ses_persist", part: { id: "p", text: "ok" } });
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(first.id)?.status === "succeeded");

    const second = startAgentTurn({ project: "demo", folder, prompt: "two", model: "m/x" });
    const args = spawnCalls[1]?.args ?? [];
    const sessionIndex = args.indexOf("--session");
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(args[sessionIndex + 1]).toBe("ses_persist");

    spawned[1]?.finish(0);
    await waitFor(() => getAgentRun(second.id)?.status === "succeeded");
  });

  it("refuses a second turn while one is running for the same folder", () => {
    const folder = nextFolder();
    startAgentTurn({ project: "demo", folder, prompt: "one", model: "m/x" });
    expect(() =>
      startAgentTurn({ project: "demo", folder, prompt: "two", model: "m/x" }),
    ).toThrowError(AgentRunError);
    expect(() =>
      startAgentTurn({ project: "demo", folder, prompt: "two", model: "m/x" }),
    ).toThrowError(/already working/);
  });

  it("records cost and ends failed when opencode fails", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hello", model: "m/x" });
    const child = spawned[0];
    child?.write({ type: "step_finish", part: { cost: 0.5 } });
    child?.stderr.write("provider exploded");
    child?.finish(1);

    await waitFor(() => getAgentRun(run.id)?.status === "failed");
    const detail = getAgentRun(run.id);
    expect(detail?.costMicros).toBe(500_000);
    expect(detail?.error).toContain("provider exploded");
    expect(detail?.events.some((event) => event.type === "cost")).toBe(true);
  });

  it("sends the prompt over stdin", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "make it good", model: "m/x" });
    const child = spawned[0];
    let sent = "";
    child?.stdin.on("data", (chunk) => {
      sent += String(chunk);
    });
    await waitFor(() => sent.includes("make it good"));
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");
    expect(sent).toContain("Slate's project agent");
  });

  it("stops a running turn", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hello", model: "m/x" });
    const stopped = stopAgentRun(run.id);
    expect(stopped.status).toBe("cancelled");
    await waitFor(() => getAgentRun(run.id)?.status === "cancelled");
    expect(spawned[0]?.killed).toBe(true);
    const events = collect(run.id);
    expect(events.at(-1)).toEqual({ type: "done", status: "cancelled", error: null });
  });

  it("reports a missing folder as 404", () => {
    expect(() =>
      startAgentTurn({ project: "nope", folder: join(root, "nope"), prompt: "x", model: "m/x" }),
    ).toThrowError(/project not found/);
  });

  it("finds the newest run for a project", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hello", model: "m/x" });
    expect(latestAgentRun("demo")?.id).toBe(run.id);
    expect(latestAgentRun("other")).toBeNull();
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");
  });

  it("keeps one session per project and continues each one separately", async () => {
    const first = nextFolder();
    const second = nextFolder();

    const runA = startAgentTurn({ project: "demo-a", folder: first, prompt: "one", model: "m/x" });
    spawned[0]?.write({ type: "text", sessionID: "ses_aaa", part: { id: "a", text: "ok" } });
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(runA.id)?.status === "succeeded");

    const runB = startAgentTurn({ project: "demo-b", folder: second, prompt: "two", model: "m/x" });
    // A new project starts clean instead of inheriting the other project's session.
    expect(spawnCalls[1]?.args).not.toContain("--session");
    spawned[1]?.write({ type: "text", sessionID: "ses_bbb", part: { id: "b", text: "ok" } });
    spawned[1]?.finish(0);
    await waitFor(() => getAgentRun(runB.id)?.status === "succeeded");

    expect(storedSessionId(first)).toBe("ses_aaa");
    expect(storedSessionId(second)).toBe("ses_bbb");

    const runA2 = startAgentTurn({ project: "demo-a", folder: first, prompt: "three", model: "m/x" });
    const args = spawnCalls[2]?.args ?? [];
    const sessionIndex = args.indexOf("--session");
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(args[sessionIndex + 1]).toBe("ses_aaa");
    spawned[2]?.finish(0);
    await waitFor(() => getAgentRun(runA2.id)?.status === "succeeded");
  });

  it("rotates a session that grew past the context limit before sending it", () => {
    const folder = nextFolder();
    writeFileSync(sessionsFile, JSON.stringify({ [folder]: "ses_bloated" }), "utf8");
    writeFileSync(`${sessionsFile}.context`, JSON.stringify({ [folder]: 90_000 }), "utf8");

    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });
    expect(spawnCalls[0]?.args).not.toContain("--session");
    expect(storedSessionId(folder)).toBeNull();
    expect(lastContextTokens(folder)).toBe(0);
    spawned[0]?.finish(0);
    expect(run.sessionId).toBeNull();
  });

  it("continues a session that is still under the context limit", () => {
    const folder = nextFolder();
    writeFileSync(sessionsFile, JSON.stringify({ [folder]: "ses_ok" }), "utf8");
    writeFileSync(`${sessionsFile}.context`, JSON.stringify({ [folder]: 20_000 }), "utf8");

    startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });
    const args = spawnCalls[0]?.args ?? [];
    const sessionIndex = args.indexOf("--session");
    expect(args[sessionIndex + 1]).toBe("ses_ok");
    spawned[0]?.finish(0);
  });

  it("resets the session on a context quota failure and leaves the model available", async () => {
    const folder = nextFolder();
    const model = "gemini/context-quota-test";
    writeFileSync(sessionsFile, JSON.stringify({ [folder]: "ses_old" }), "utf8");

    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model });
    const child = spawned[0];
    child?.write({ type: "text", sessionID: "ses_old", part: { id: "p", text: "ok" } });
    child?.write({
      type: "step_finish",
      sessionID: "ses_old",
      part: { cost: 0.01, tokens: { input: 300_000, cache: { read: 0 } } },
    });
    child?.write({
      type: "error",
      sessionID: "ses_old",
      error: {
        type: "provider.quota",
        message:
          "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.5-flash-lite. Please retry in 15.6s.",
      },
    });
    // A late line must not re-save the bloated session id.
    child?.write({ type: "text", sessionID: "ses_old", part: { id: "q", text: "late" } });
    child?.finish(1);

    await waitFor(() => getAgentRun(run.id)?.status === "failed");

    const detail = getAgentRun(run.id);
    const errorEvent = detail?.events.find((event) => event.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.message).toContain(
      "250,000 input tokens per minute",
    );
    expect(errorEvent?.type === "error" && errorEvent.message).toContain(
      "not your allowance running out",
    );
    expect(storedSessionId(folder)).toBeNull();
    expect(lastContextTokens(folder)).toBe(0);
    expect(modelUnavailabilityOf(model)).toBeNull();
  });

  it("also catches a context quota that only reaches stderr", async () => {
    const folder = nextFolder();
    const model = "gemini/stderr-quota-test";
    writeFileSync(sessionsFile, JSON.stringify({ [folder]: "ses_stderr" }), "utf8");

    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model });
    spawned[0]?.stderr.write(
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 10s.",
    );
    spawned[0]?.finish(1);

    await waitFor(() => getAgentRun(run.id)?.status === "failed");
    expect(getAgentRun(run.id)?.error).toContain("250,000 input tokens per minute");
    expect(storedSessionId(folder)).toBeNull();
    expect(modelUnavailabilityOf(model)).toBeNull();
  });

  it("keeps a model-wide free limit blocked for its retry window", async () => {
    const folder = nextFolder();
    const model = "opencode/free-limit-test";
    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model });
    spawned[0]?.write({
      type: "error",
      error: { type: "provider.free-limit", message: "free limit reached", retryAfterMs: 60_000 },
    });
    spawned[0]?.finish(1);

    await waitFor(() => getAgentRun(run.id)?.status === "failed");
    expect(modelUnavailabilityOf(model)?.reason).toBe("provider.free-limit");
  });
});

describe("project opencode config", () => {
  it("keeps whatever else the folder's config already says", () => {
    const folder = nextFolder();
    mkdirSync(join(folder, ".opencode"), { recursive: true });
    writeFileSync(
      join(folder, ".opencode", "opencode.json"),
      JSON.stringify({ model: "someone/else", mcp: { servers: { other: { type: "local", command: ["x"] } } } }),
      "utf8",
    );

    startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });

    const config = JSON.parse(
      readFileSync(join(folder, ".opencode", "opencode.json"), "utf8"),
    ) as { model?: string; mcp: { servers: Record<string, unknown> } };
    expect(config.model).toBe("someone/else");
    expect(config.mcp.servers["other"]).toBeDefined();
    expect(config.mcp.servers["slate"]).toBeDefined();
    spawned[0]?.finish(0);
  });

  it("points the server at this project and folder", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });
    const config = JSON.parse(
      readFileSync(join(folder, ".opencode", "opencode.json"), "utf8"),
    ) as { mcp: { servers: Record<string, { environment: Record<string, string> }> } };
    const environment = config.mcp.servers["slate"]?.environment ?? {};
    expect(environment["SLATE_PROJECT"]).toBe("demo");
    expect(environment["SLATE_MCP_FOLDER"]).toBe(folder);
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");
  });

  it("denies the plan agent every way of running a command or editing a file", () => {
    const folder = nextFolder();
    startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x", focus: "goals" });
    const config = JSON.parse(
      readFileSync(join(folder, ".opencode", "opencode.json"), "utf8"),
    ) as {
      agents: {
        plan: {
          permissions: { action: string; effect: string }[];
          tools: Record<string, boolean>;
        };
      };
    };
    const denied = config.agents.plan.permissions
      .filter((permission) => permission.effect === "deny")
      .map((permission) => permission.action);
    for (const action of ["edit", "bash", "shell", "read", "glob", "grep", "task"]) {
      expect(denied).toContain(action);
    }
    expect(config.agents.plan.tools["write"]).toBe(false);
    expect(config.agents.plan.tools["shell"]).toBe(false);
    spawned[0]?.finish(0);
  });
});

describe("sessions file", () => {
  it("keeps one session id per folder", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });
    spawned[0]?.write({ type: "text", sessionID: "ses_kept", part: { id: "p", text: "ok" } });
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");

    const map = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, string>;
    expect(map[folder]).toBe("ses_kept");

    // A file written by an older build with a bad id is ignored rather than passed to the CLI.
    writeFileSync(sessionsFile, JSON.stringify({ [join(root, "other")]: "not-a-session" }), "utf8");
    expect(storedSessionId(join(root, "other"))).toBeNull();
  });

  it("remembers the request size beside the session id", async () => {
    const folder = nextFolder();
    const run = startAgentTurn({ project: "demo", folder, prompt: "hi", model: "m/x" });
    spawned[0]?.write({ type: "text", sessionID: "ses_sized", part: { id: "p", text: "ok" } });
    spawned[0]?.write({
      type: "step_finish",
      sessionID: "ses_sized",
      part: { cost: 0.02, tokens: { input: 1_000, cache: { read: 500 } } },
    });
    spawned[0]?.finish(0);
    await waitFor(() => getAgentRun(run.id)?.status === "succeeded");

    expect(lastContextTokens(folder)).toBe(1_500);
    const map = JSON.parse(readFileSync(`${sessionsFile}.context`, "utf8")) as Record<string, number>;
    expect(map[folder]).toBe(1_500);
  });

  it("clears the session id and the remembered size together", () => {
    const folder = nextFolder();
    writeFileSync(sessionsFile, JSON.stringify({ [folder]: "ses_clear", other: "ses_keep" }), "utf8");
    writeFileSync(
      `${sessionsFile}.context`,
      JSON.stringify({ [folder]: 90_000, other: 1_000 }),
      "utf8",
    );

    clearStoredSessionId(folder);

    expect(storedSessionId(folder)).toBeNull();
    expect(lastContextTokens(folder)).toBe(0);
    expect(storedSessionId("other")).toBe("ses_keep");
    expect(lastContextTokens("other")).toBe(1_000);
  });
});
