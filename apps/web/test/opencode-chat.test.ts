import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  completeWithOpencode,
  formatConversation,
  setOpencodeSpawn,
  type OpencodeSpawn,
} from "@/lib/opencode-chat";

/** A fake opencode CLI that records what it was given. */
class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  prompt = "";
  args: readonly string[] = [];
  env: Record<string, string | undefined> = {};

  kill(): boolean {
    return true;
  }
}

let fake: FakeCli | null = null;

afterEach(() => {
  setOpencodeSpawn(null);
  fake = null;
});

function useFakeCli(): FakeCli {
  const cli = new FakeCli();
  fake = cli;
  cli.stdin.on("data", (chunk: Buffer | string) => {
    cli.prompt += String(chunk);
  });
  cli.stdout.on("data", () => {
    // Drain, so the runner does not stall.
  });

  const spawnFake: OpencodeSpawn = (_binary, args, options) => {
    cli.args = args;
    cli.env = options.env;
    return cli as unknown as ReturnType<OpencodeSpawn>;
  };
  setOpencodeSpawn(spawnFake);
  return cli;
}

describe("formatConversation", () => {
  it("carries the system prompt and every turn", () => {
    const prompt = formatConversation("You are Slate.", [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);

    expect(prompt).toContain("You are Slate.");
    expect(prompt).toContain("User:");
    expect(prompt).toContain("first");
    expect(prompt).toContain("Assistant:");
    expect(prompt).toContain("second");
  });

  it("can be longer than the Windows command-line limit", () => {
    const long = "x".repeat(40_000);
    const prompt = formatConversation(long, [{ role: "user", content: long }]);

    expect(prompt.length).toBeGreaterThan(8191);
    expect(prompt).toContain(long);
  });
});

describe("completeWithOpencode", () => {
  it("runs the CLI read-only, in the given folder", async () => {
    const cli = useFakeCli();

    const promise = completeWithOpencode("opencode/some-model", "system", [
      { role: "user", content: "hello" },
    ], { cwd: "C:\\some\\project" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The read-only agent cannot write files or run shell commands.
    expect(cli.args).toContain("--agent");
    expect(cli.args[cli.args.indexOf("--agent") + 1]).toBe("plan");

    // A private server, so another session's settings cannot change what this run may do.
    expect(cli.args).toContain("--standalone");

    // The write tools are denied outright, not just asked not to be used.
    const config = cli.env.OPENCODE_CONFIG_CONTENT ?? "";
    expect(config).toContain('"edit":"deny"');
    expect(config).toContain('"bash":"deny"');
    // The shell and subagent tools are the ones the built-in plan agent leaves behind.
    expect(config).toContain('"shell":false');
    expect(config).toContain('"task":false');
    expect(config).toContain('"write":false');
    expect(config).toContain('"execute":false');

    cli.stdout.write(
      `${JSON.stringify({ type: "text", part: { type: "text", text: "ok" } })}\n`,
    );
    cli.emit("close", 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.mayHaveEditedFiles).toBe(false);
  });

  it("passes the prompt over stdin instead of the command line", async () => {
    const cli = useFakeCli();
    const long = "y".repeat(20_000);

    const promise = completeWithOpencode("opencode/some-model", long, [
      { role: "user", content: long },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The prompt must not be an argument: the arguments stay short.
    expect(cli.args.join(" ")).not.toContain(long);
    expect(cli.args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "opencode/some-model",
      "--agent",
      "plan",
      "--standalone",
    ]);

    // It arrives on stdin instead.
    expect(cli.prompt.length).toBeGreaterThan(8191);
    expect(cli.prompt).toContain(long);

    cli.stdout.write(
      `${JSON.stringify({ type: "text", part: { type: "text", text: "ok" } })}\n`,
    );
    cli.emit("close", 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("ok");
  });

  it("reports the CLI's error output", async () => {
    const cli = useFakeCli();

    const promise = completeWithOpencode("opencode/some-model", "system", [
      { role: "user", content: "hello" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    cli.stderr.write("something went wrong\n");
    cli.emit("close", 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("something went wrong");
  });
});
