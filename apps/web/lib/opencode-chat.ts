import { spawn, type ChildProcess } from "node:child_process";

import type { AgentMessage, ChatToolCall, ChatTurn } from "@slate/shared";

import { resolveOpencodeBinary } from "./opencode-binary";

export interface OpencodeTextResult {
  ok: boolean;
  reply: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  /**
   * True when the model may have changed files itself, because the CLI was allowed to run its
   * own tools. Slate cannot see or undo those changes, so the UI says so.
   */
  mayHaveEditedFiles: boolean;
}

/** How long the CLI may take before the run is given up on. */
const TIMEOUT_MS = 180_000;

/** The most output we keep from one run. */
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

/** How the CLI is started. Tests replace it. */
export type OpencodeSpawn = (
  binary: string,
  args: readonly string[],
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  },
) => ChildProcess;

/**
 * A configuration that takes every writing tool away from the plan agent.
 *
 * The built-in plan agent only denies the edit tool: bash, shell, execute and the subagent tool
 * are still there, so a model that is told "you may not write" can simply fall back to the shell
 * and write anyway. That is why the plan agent sometimes obeyed and sometimes did not.
 *
 * Disabling the tools outright, and denying the permissions behind them, closes that gap. The
 * `agent.plan` block overrides the built-in agent, so this has to name every writing tool.
 */
export const READ_ONLY_CONFIG = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  agent: {
    plan: {
      tools: {
        execute: false,
        bash: false,
        shell: false,
        write: false,
        edit: false,
        patch: false,
        multiedit: false,
        task: false,
        subagent: false,
      },
      permission: {
        edit: "deny",
        bash: "deny",
        task: "deny",
      },
    },
  },
});

let spawnImpl: OpencodeSpawn = spawn;

/** Replace the CLI spawner. Pass null to restore the real one. */
export function setOpencodeSpawn(fn: OpencodeSpawn | null): void {
  spawnImpl = fn ?? spawn;
}

export function formatConversation(
  system: string,
  messages: Array<ChatTurn | AgentMessage>,
): string {
  const parts: string[] = [system.trim(), ""];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const toolMessage = message as AgentMessage;
      parts.push(`Tool result (${toolMessage.tool_call_id ?? "tool"}):`);
      parts.push(typeof message.content === "string" ? message.content : "");
      parts.push("");
      continue;
    }
    if (message.role === "assistant") {
      const assistant = message as AgentMessage;
      const toolCalls = Array.isArray(assistant.tool_calls) ? (assistant.tool_calls as ChatToolCall[]) : [];
      if (toolCalls.length > 0) {
        const calls = toolCalls
          .map((call) => `${call.function.name}(${call.function.arguments})`)
          .join("\n");
        parts.push("Assistant tool calls:");
        parts.push(calls);
        if (typeof assistant.content === "string" && assistant.content.trim() !== "") {
          parts.push(assistant.content);
        }
        parts.push("");
        continue;
      }
    }
    if (typeof message.content !== "string" || message.content.trim() === "") continue;
    parts.push(message.role === "user" ? "User:" : "Assistant:");
    parts.push(message.content);
    parts.push("");
  }
  return parts.join("\n").trim();
}

function parseRunOutput(raw: string): { reply: string; promptTokens: number | null; completionTokens: number | null } {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  const texts: string[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        part?: { type?: unknown; text?: unknown; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown } };
      };
      if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
        texts.push(event.part.text);
      }
      if (event.type === "step_finish" && event.part?.tokens && typeof event.part.tokens === "object") {
        const tokens = event.part.tokens as { input?: unknown; output?: unknown; reasoning?: unknown };
        const input = typeof tokens.input === "number" ? tokens.input : 0;
        const output = typeof tokens.output === "number" ? tokens.output : 0;
        const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
        promptTokens = input;
        completionTokens = output + reasoning;
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  if (texts.length > 0) {
    return { reply: texts.join("").trim(), promptTokens, completionTokens };
  }
  return { reply: raw.trim(), promptTokens, completionTokens };
}

/**
 * Run a prompt through an opencode-provider free model via the local opencode CLI.
 *
 * The prompt goes in over stdin, never as a command-line argument: Windows caps a command line at
 * 8191 characters, and a conversation carrying a project README is longer than that.
 */
export async function completeWithOpencode(
  model: string,
  system: string,
  messages: Array<ChatTurn | AgentMessage>,
  options?: { cwd?: string },
): Promise<OpencodeTextResult> {
  const prompt = formatConversation(system, messages);
  const cliModel = model.startsWith("opencode/") ? model : `opencode/${model}`;
  const binary = resolveOpencodeBinary();

  if (binary === null) {
    return {
      ok: false,
      reply: "",
      model,
      promptTokens: null,
      completionTokens: null,
      error: "the opencode CLI was not found on this machine",
      mayHaveEditedFiles: false,
    };
  }

  return new Promise<OpencodeTextResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const done = (result: OpencodeTextResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(
        binary,
        // "plan" is the read-only agent, and "--standalone" gives the run its own server instead
        // of the shared background service, so another session's settings cannot change what this
        // run is allowed to do. READ_ONLY_CONFIG denies the write tools outright.
        ["run", "--format", "json", "--model", cliModel, "--agent", "plan", "--standalone"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            OPENCODE_CONFIG_CONTENT: READ_ONLY_CONFIG,
          },
          cwd: options?.cwd,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      done({
        ok: false,
        reply: "",
        model,
        promptTokens: null,
        completionTokens: null,
        error: message,
        mayHaveEditedFiles: false,
      });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      done({
        ok: false,
        reply: "",
        model,
        promptTokens: null,
        completionTokens: null,
        error: "opencode took too long to answer",
        mayHaveEditedFiles: false,
      });
    }, TIMEOUT_MS);
    timer.unref();

    child.on("error", (error) => {
      done({
        ok: false,
        reply: "",
        model,
        promptTokens: null,
        completionTokens: null,
        error: error.message,
        mayHaveEditedFiles: false,
      });
    });

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
      });
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
      });
    }

    child.on("close", (code) => {
      const parsed = parseRunOutput(stdout);
      if (code !== 0 && code !== null) {
        const detail = stderr.trim() || parsed.reply || `opencode exited with code ${code}`;
        done({
          ok: false,
          reply: "",
          model,
          promptTokens: parsed.promptTokens,
          completionTokens: parsed.completionTokens,
          error: detail.slice(0, 400),
          mayHaveEditedFiles: false,
        });
        return;
      }

      if (parsed.reply === "") {
        done({
          ok: false,
          reply: "",
          model,
          promptTokens: parsed.promptTokens,
          completionTokens: parsed.completionTokens,
          error: stderr.trim().slice(0, 400) || "opencode returned an empty reply",
          mayHaveEditedFiles: false,
        });
        return;
      }

      done({
        ok: true,
        reply: parsed.reply,
        model,
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        error: null,
        mayHaveEditedFiles: false,
      });
    });

    // The prompt travels over stdin, so its length is never limited by the command line.
    if (child.stdin !== null) {
      child.stdin.on("error", () => {
        // The CLI may close stdin early; the close handler reports the real failure.
      });
      child.stdin.end(prompt, "utf8");
    }
  });
}
