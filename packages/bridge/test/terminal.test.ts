import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearTerminals,
  defaultShell,
  getTerminal,
  killTerminal,
  listTerminals,
  reconcileTerminals,
  removeTerminal,
  resizeTerminal,
  startTerminal,
  subscribeTerminal,
  writeTerminal,
} from "@slate/bridge";
import { setPtySpawn } from "@slate/bridge";

const created: string[] = [];
function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-terminal-"));
  created.push(folder);
  return folder;
}

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for the process"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

afterEach(async () => {
  // Stop any session this test left running and wait for its process to exit,
  // otherwise Windows refuses to delete the working directory.
  for (const session of listTerminals()) {
    if (session.status === "running") killTerminal(session.id);
  }
  if (listTerminals().some((session) => session.status === "running")) {
    await waitFor(() => !listTerminals().some((session) => session.status === "running"), 4000).catch(
      () => undefined,
    );
  }
  clearTerminals();
  while (created.length) {
    const folder = created.pop();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
});

describe("defaultShell", () => {
  it("opens a persistent PowerShell on Windows", () => {
    const shell = defaultShell("win32", { ...process.env, SystemRoot: "C:\\Windows" });
    expect(shell.file.toLowerCase()).toContain("windowspowershell\\v1.0\\powershell.exe");
    expect(shell.args).toEqual(["-NoLogo", "-NoProfile", "-NoExit"]);
  });

  it.skipIf(process.platform !== "win32")("keeps the PowerShell session alive between commands", async () => {
    const session = startTerminal({ cwd: process.cwd(), command: "", interactive: true, pty: true });

    try {
      await waitFor(() => getTerminal(session.id)?.output.includes("PS ") === true);
      writeTerminal(session.id, "Write-Output '__SLATE_PS_FIRST__'\r\n");
      await waitFor(() => getTerminal(session.id)?.output.includes("__SLATE_PS_FIRST__") === true);
      writeTerminal(session.id, "Write-Output '__SLATE_PS_SECOND__'\r\n");
      await waitFor(() => getTerminal(session.id)?.output.includes("__SLATE_PS_SECOND__") === true);

      expect(getTerminal(session.id)?.status).toBe("running");
      expect(getTerminal(session.id)?.output).not.toContain("no pseudo-terminal");
    } finally {
      killTerminal(session.id);
      await waitFor(() => getTerminal(session.id)?.status !== "running");
    }
  });
});

describe("startTerminal", () => {
  it("streams stdout and records the exit in the buffer", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "console.log('hello terminal')"],
      shell: false,
    });

    expect(session.status).toBe("running");
    expect(session.cwd).toBe(folder);
    await waitFor(() => getTerminal(session.id)?.status !== "running");

    const detail = getTerminal(session.id);
    expect(detail?.status).toBe("exited");
    expect(detail?.exitCode).toBe(0);
    expect(detail?.output).toContain("hello terminal");
  });

  it("streams stderr separately from stdout", async () => {
    const folder = makeFolder();
    const events: { type: string; text?: string }[] = [];
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "console.error('oops'); console.log('fine')"],
      shell: false,
    });
    const unsubscribe = subscribeTerminal(session.id, (event) => {
      events.push(event);
    });

    await waitFor(() => getTerminal(session.id)?.status !== "running");
    unsubscribe();

    const stderr = events.find((event) => event.type === "stderr");
    const stdout = events.find((event) => event.type === "stdout");
    expect(stderr?.text).toContain("oops");
    expect(stdout?.text).toContain("fine");
    expect(events.some((event) => event.type === "exit")).toBe(true);
  });

  it("accepts stdin input for interactive processes", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data', (chunk) => { process.stdout.write('got:' + chunk); })",
      ],
      shell: false,
    });

    writeTerminal(session.id, "ping\n");
    await waitFor(() => getTerminal(session.id)?.output.includes("got:ping") === true);
    killTerminal(session.id);
  });

  it("runs in a pseudo-terminal when asked, and takes input there", async () => {
    const folder = makeFolder();
    const written: string[] = [];
    let resized: { cols: number; rows: number } | null = null;
    let killed = false;

    setPtySpawn((_command, _args, _options) => ({
      write: (data: string) => {
        written.push(data);
      },
      resize: (cols: number, rows: number) => {
        resized = { cols, rows };
      },
      kill: () => {
        killed = true;
      },
      onData: () => undefined,
      onExit: () => undefined,
    }));

    const session = startTerminal({
      cwd: folder,
      command: "cmd.exe",
      shell: false,
      pty: true,
      cols: 100,
      rows: 30,
    });

    writeTerminal(session.id, "echo hi\r");
    expect(written).toEqual(["echo hi\r"]);

    resizeTerminal(session.id, 120, 40);
    expect(resized).toEqual({ cols: 120, rows: 40 });

    killTerminal(session.id);
    expect(killed).toBe(true);
    expect(getTerminal(session.id)?.status).toBe("cancelled");

    setPtySpawn(null);
  });

  it("falls back to pipes when no pseudo-terminal is available", () => {
    const folder = makeFolder();
    setPtySpawn(() => {
      throw new Error("no pseudo-terminal here");
    });

    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "process.stdout.write('piped')"],
      shell: false,
      pty: true,
    });

    // The session still runs, with pipes.
    expect(session.status).toBe("running");
    expect(getTerminal(session.id)?.output).toContain("no pseudo-terminal");
    killTerminal(session.id);
    setPtySpawn(null);
  });

  it("refuses a working directory outside the allowlist", async () => {
    const folder = makeFolder();
    const outside = makeFolder();
    expect(() =>
      startTerminal({
        cwd: outside,
        command: process.execPath,
        args: ["-e", ""],
        shell: false,
        allowlistRoot: folder,
      }),
    ).toThrow(/outside the allowed root/);
    expect(existsSync(folder)).toBe(true);
  });

  it("refuses a refused path", () => {
    const refused = process.platform === "win32" ? "C:\\Windows" : "/etc";
    expect(() =>
      startTerminal({ cwd: refused, command: "echo hi", shell: true }),
    ).toThrow(/refused path/i);
  });

  it("refuses a missing directory and a file as cwd", () => {
    const folder = makeFolder();
    expect(() =>
      startTerminal({ cwd: join(folder, "nope"), command: "echo hi" }),
    ).toThrow(/not found/i);
    const file = join(folder, "file.txt");
    writeFileSync(file, "x");
    expect(() => startTerminal({ cwd: file, command: "echo hi" })).toThrow(/not a folder/i);
  });

  it("caps the output buffer instead of growing forever", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      // Print ~400 KB of output; the buffer keeps only the tail.
      command: process.execPath,
      args: ["-e", "for (let i = 0; i < 4000; i++) console.log('x'.repeat(100))"],
      shell: false,
    });

    await waitFor(() => getTerminal(session.id)?.status !== "running");
    const detail = getTerminal(session.id);
    expect(detail?.output.length).toBeLessThanOrEqual(200_000 + 64);
    expect(detail?.output).toContain("[earlier output truncated]");
  });
});

describe("terminal environment", () => {
  it("unbuffers Python so a server's port appears while it runs", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "console.log('unbuffered=' + process.env.PYTHONUNBUFFERED)"],
      shell: false,
    });

    await waitFor(() => getTerminal(session.id)?.status !== "running");
    expect(getTerminal(session.id)?.output).toContain("unbuffered=1");
  });

  it("lets the caller override the environment", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "console.log('unbuffered=' + process.env.PYTHONUNBUFFERED)"],
      shell: false,
      env: { PYTHONUNBUFFERED: "0" },
    });

    await waitFor(() => getTerminal(session.id)?.status !== "running");
    expect(getTerminal(session.id)?.output).toContain("unbuffered=0");
  });
});

describe("killTerminal", () => {
  it("stops a long-running process and reports it cancelled", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shell: false,
    });

    expect(session.status).toBe("running");
    killTerminal(session.id);
    await waitFor(() => getTerminal(session.id)?.status !== "running");
    expect(getTerminal(session.id)?.status).toBe("cancelled");
  });

  it("leaves an exited session alone", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", ""],
      shell: false,
    });

    await waitFor(() => getTerminal(session.id)?.status !== "running");
    const before = getTerminal(session.id);
    killTerminal(session.id);
    expect(getTerminal(session.id)?.status).toBe(before?.status);
  });
});

describe("listTerminals and housekeeping", () => {
  it("lists sessions for one project and newest first", async () => {
    const folder = makeFolder();
    const first = startTerminal({ cwd: folder, command: process.execPath, args: ["-e", ""], shell: false, project: "alpha" });
    const second = startTerminal({ cwd: folder, command: process.execPath, args: ["-e", ""], shell: false, project: "beta" });

    const alphas = listTerminals({ project: "alpha" });
    expect(alphas.map((entry) => entry.id)).toEqual([first.id]);
    expect(listTerminals({ project: "mixed" })).toHaveLength(0);
    expect(
      [...listTerminals()].map((entry) => entry.id).sort(),
    ).toContain(second.id);
  });

  it("removeTerminal refuses a running session and removes a finished one", async () => {
    const folder = makeFolder();
    const running = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shell: false,
    });
    expect(() => removeTerminal(running.id)).toThrow(/stop the session/);

    killTerminal(running.id);
    await waitFor(() => getTerminal(running.id)?.status !== "running");
    removeTerminal(running.id);
    expect(getTerminal(running.id)).toBeNull();
  });

  it("reconcileTerminals fails a running session with no process attached", async () => {
    const folder = makeFolder();
    const session = startTerminal({
      cwd: folder,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shell: false,
    });

    const store = globalThis as unknown as {
      __slateTerminals?: Map<
        string,
        { child: ChildProcess | null; record: { status: string; endedAt: string | null } }
      >;
    };
    const stored = store.__slateTerminals?.get(session.id);

    // Stop the real process first, so Windows can delete the folder afterwards.
    const child = stored?.child;
    if (child !== undefined && child !== null) {
      child.kill();
      await waitFor(() => getTerminal(session.id)?.status !== "running", 4000).catch(
        () => undefined,
      );
    }

    // Now pretend the server restarted while the session was still running: the record says
    // "running", but there is no process behind it any more.
    if (stored !== undefined) {
      stored.child = null;
      stored.record.status = "running";
      stored.record.endedAt = null;
    }

    reconcileTerminals();
    expect(getTerminal(session.id)?.status).toBe("failed");
    expect(getTerminal(session.id)?.error).toContain("interrupted");
  });

  it("reconcileTerminals leaves a live pseudo-terminal session running", () => {
    const folder = makeFolder();
    setPtySpawn((_command, _args, _options) => ({
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined,
    }));

    const ptySession = startTerminal({
      cwd: folder,
      command: "powershell.exe",
      shell: false,
      pty: true,
      cols: 80,
      rows: 24,
    });

    // A session whose process lives in the pseudo-terminal is alive; listing must not reconcile it.
    reconcileTerminals();
    expect(getTerminal(ptySession.id)?.status).toBe("running");

    killTerminal(ptySession.id);
    setPtySpawn(null);
  });
});
