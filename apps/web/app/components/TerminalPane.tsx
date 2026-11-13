"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TerminalSession {
  id: string;
  project: string | null;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed" | "cancelled";
  exitCode?: number | null;
  createdAt: string;
  endedAt: string | null;
}

interface TerminalSetupDescriptor {
  command: string;
  activateCommand: string | null;
  venvExists: boolean;
  fingerprint: string;
  label: string;
  successMarker: string;
  failureMarker: string;
  activationMarker: string;
}

interface PendingDependencySetup {
  sessionId: string;
  fingerprint: string;
  successMarker: string;
  failureMarker: string;
  mode: "install" | "activate";
}

interface StoredDependencySetup {
  fingerprint?: unknown;
  status?: unknown;
  sessionId?: unknown;
}

function storeDependencySetup(
  slug: string,
  fingerprint: string,
  status: "installing" | "activating" | "ready" | "failed",
  sessionId: string,
): void {
  try {
    window.localStorage.setItem(
      `slate:terminal:dependencies:v2:${slug}`,
      JSON.stringify({ fingerprint, status, sessionId }),
    );
  } catch {
    // Storage may be unavailable; the current shell session still works.
  }
}

interface TerminalPaneProps {
  slug: string;
  /** A running session to attach to, when the page remembers one. */
  sessionId: string | null;
  onSessionChange: (id: string | null) => void;
  /** Called with every chunk of output, so the page can look for a dev-server port. */
  onOutput?: (text: string) => void;
  /** Called when the active session's process ends, so the page can drop its preview. */
  onSessionEnd?: (id: string) => void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export default function TerminalPane({
  slug,
  sessionId,
  onSessionChange,
  onOutput,
  onSessionEnd,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const outputRef = useRef(onOutput);
  outputRef.current = onOutput;
  const dependencySetupRef = useRef<PendingDependencySetup | null>(null);
  const dependencySetupOutputRef = useRef("");
  const setupRunningRef = useRef(false);

  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(sessionId);
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  const activeIdRef = useRef<string | null>(sessionId);
  activeIdRef.current = activeId;
  const activeSessionRef = useRef<TerminalSession | null>(null);
  if (activeId === null) {
    activeSessionRef.current = null;
  } else {
    const selectedSession = sessions.find((session) => session.id === activeId);
    if (selectedSession !== undefined) activeSessionRef.current = selectedSession;
    else if (activeSessionRef.current?.id !== activeId) activeSessionRef.current = null;
  }

  // Load the project's sessions.
  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/terminal?project=${encodeURIComponent(slug)}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as { ok: boolean; sessions?: TerminalSession[] };
      if (!body.ok) return;
      setSessions(body.sessions ?? []);
    } catch {
      // The next refresh tries again.
    }
  }, [slug]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const selectSession = useCallback(
    (session: TerminalSession) => {
      activeSessionRef.current = session;
      setActiveId(session.id);
      onSessionChange(session.id);
    },
    [onSessionChange],
  );

  const finishDependencySetup = useCallback(
    (sessionId: string, text: string) => {
      const pending = dependencySetupRef.current;
      if (pending === null || pending.sessionId !== sessionId) return;

      dependencySetupOutputRef.current = `${dependencySetupOutputRef.current}${text}`.slice(-1000);
      const output = dependencySetupOutputRef.current;
      if (!output.includes(pending.successMarker) && !output.includes(pending.failureMarker)) return;

      dependencySetupRef.current = null;
      dependencySetupOutputRef.current = "";
      setupRunningRef.current = false;
      setSetupRunning(false);
      if (output.includes(pending.successMarker)) {
        storeDependencySetup(slug, pending.fingerprint, "ready", pending.sessionId);
        setSetupMessage("PowerShell is ready. Type a command below or directly into the terminal.");
      } else {
        storeDependencySetup(slug, pending.fingerprint, "failed", pending.sessionId);
        setSetupMessage("Setup failed; PowerShell is still open. Check the output, then rerun the install command here.");
      }
    },
    [slug],
  );

  // Opening the dock starts or reattaches to a persistent shell. Dependency setup runs inside
  // that shell so it returns to a usable PowerShell prompt instead of leaving a dead install job.
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      let setup: TerminalSetupDescriptor | null = null;
      try {
        const setupResponse = await fetch(
          `/api/terminal/setup?project=${encodeURIComponent(slug)}`,
          { cache: "no-store" },
        );
        const setupBody = (await setupResponse.json()) as {
          ok: boolean;
          setup?: TerminalSetupDescriptor | null;
        };
        if (setupResponse.ok && setupBody.ok) {
          setup = setupBody.setup ?? null;
        }
      } catch {
        // The shell itself should still open if dependency discovery fails.
      }

      const storageKey = `slate:terminal:dependencies:v2:${slug}`;
      let stored: StoredDependencySetup | null = null;
      try {
        const raw = window.localStorage.getItem(storageKey);
        stored = raw === null ? null : (JSON.parse(raw) as StoredDependencySetup);
      } catch {
        // Continue without persisted setup state if browser storage is unavailable.
      }

      try {
        const sessionsResponse = await fetch(
          `/api/terminal?project=${encodeURIComponent(slug)}`,
          { cache: "no-store" },
        );
        const sessionsBody = (await sessionsResponse.json()) as {
          ok: boolean;
          sessions?: TerminalSession[];
        };
        const existingShell = sessionsBody.sessions
          ?.filter((session) => session.status === "running" && session.command === "shell")
          .at(-1);
        if (existingShell !== undefined) {
          if (!cancelled) {
            setSessions(sessionsBody.sessions ?? []);
            selectSession(existingShell);
            if (
              setup !== null &&
              stored?.fingerprint === setup.fingerprint &&
              (stored.status === "installing" || stored.status === "activating") &&
              stored.sessionId === existingShell.id
            ) {
              const mode = stored.status === "installing" ? "install" : "activate";
              dependencySetupRef.current = {
                sessionId: existingShell.id,
                fingerprint: setup.fingerprint,
                successMarker: mode === "install" ? setup.successMarker : setup.activationMarker,
                failureMarker: setup.failureMarker,
                mode,
              };
              setupRunningRef.current = true;
              setSetupRunning(true);
              setSetupMessage(
                mode === "install"
                  ? `Preparing ${setup.label} in this project's environment…`
                  : "Activating this project's Python venv…",
              );
            } else if (setup !== null && stored?.status === "failed") {
              setSetupMessage("The previous dependency install failed. PowerShell is open; check the output or retry the install command manually.");
            } else {
              setSetupMessage("PowerShell is ready. Type a command below or directly into the terminal.");
            }
          }
          return;
        }

        const startResponse = await fetch("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: slug,
            command: "",
            interactive: true,
            confirm: true,
            pty: true,
            cols: termRef.current?.cols ?? DEFAULT_COLS,
            rows: termRef.current?.rows ?? DEFAULT_ROWS,
          }),
        });
        const startBody = (await startResponse.json()) as {
          ok: boolean;
          session?: TerminalSession;
          error?: string;
        };
        if (!startResponse.ok || !startBody.ok || startBody.session === undefined) {
          throw new Error(startBody.error ?? "PowerShell could not be started");
        }

        const shell = startBody.session;
        if (cancelled) return;
        selectSession(shell);
        setSessions((current) => [...current.filter((session) => session.id !== shell.id), shell]);
        await loadSessions();
        if (setup === null) {
          setSetupMessage("PowerShell is ready. Type a command below or directly into the terminal.");
          return;
        }

        const sameVersion = stored?.fingerprint === setup.fingerprint;
        const alreadyReady = sameVersion && stored?.status === "ready" && (!setup.activateCommand || setup.venvExists);
        if (alreadyReady) {
          if (setup.activateCommand !== null) {
            setSetupMessage("Activating this project's Python venv…");
            setupRunningRef.current = true;
            setSetupRunning(true);
            storeDependencySetup(slug, setup.fingerprint, "activating", shell.id);
            dependencySetupRef.current = {
              sessionId: shell.id,
              fingerprint: setup.fingerprint,
              successMarker: setup.activationMarker,
              failureMarker: setup.failureMarker,
              mode: "activate",
            };
            window.setTimeout(() => {
              void sendToSession(shell.id, `${setup?.activateCommand ?? ""}\r`).then((sent) => {
                if (sent || dependencySetupRef.current?.sessionId !== shell.id) return;
                dependencySetupRef.current = null;
                setupRunningRef.current = false;
                setSetupRunning(false);
                storeDependencySetup(slug, setup?.fingerprint ?? "", "failed", shell.id);
                setSetupMessage("The venv could not be activated. PowerShell is open; activate it manually.");
              });
            }, 500);
          } else {
            setSetupMessage("Dependencies are ready. PowerShell is open.");
          }
          return;
        }

        if (sameVersion && stored?.status === "failed") {
          setSetupMessage("The previous dependency install failed. PowerShell is open; check the output or retry the install command manually.");
          return;
        }

        storeDependencySetup(slug, setup.fingerprint, "installing", shell.id);
        setupRunningRef.current = true;
        setSetupRunning(true);
        setSetupMessage(`Preparing ${setup.label} in this project's environment…`);
        dependencySetupRef.current = {
          sessionId: shell.id,
          fingerprint: setup.fingerprint,
          successMarker: setup.successMarker,
          failureMarker: setup.failureMarker,
          mode: "install",
        };
        window.setTimeout(() => {
          void sendToSession(shell.id, `${setup?.command ?? ""}\r`).then((sent) => {
            if (sent || dependencySetupRef.current?.sessionId !== shell.id) return;
            dependencySetupRef.current = null;
            setupRunningRef.current = false;
            setSetupRunning(false);
            storeDependencySetup(slug, setup?.fingerprint ?? "", "failed", shell.id);
            setSetupMessage("The install command could not be sent. PowerShell is open; run the install command manually.");
          });
        }, 500);
      } catch (caught) {
        if (cancelled) return;
        setSetupMessage(caught instanceof Error ? caught.message : String(caught));
      }
    };

    void prepare();
    return () => {
      cancelled = true;
    };
  }, [loadSessions, selectSession, slug]);

  // Create the terminal once, and keep it across sessions.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#12140f",
        foreground: "#e6e6e3",
        cursor: "#6fc2a5",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const onData = (data: string) => {
      const id = activeIdRef.current;
      const session = activeSessionRef.current;
      if (
        id === null ||
        setupRunningRef.current ||
        session?.id !== id ||
        session.command !== "shell" ||
        session.status !== "running"
      ) {
        return;
      }
      void fetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: data }),
      }).catch(() => undefined);
    };
    term.onData(onData);

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Attach to the active session's stream.
  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;

    const term = termRef.current;
    if (term === null || activeId === null) return;

    const source = new EventSource(
      `/api/terminal/${encodeURIComponent(activeId)}/stream`,
    );
    sourceRef.current = source;

    source.addEventListener("stdout", (event) => {
      const data = (event as MessageEvent<string>).data;
      term.write(data);
      if (dependencySetupRef.current?.sessionId === activeId) {
        finishDependencySetup(activeId, data);
      } else {
        outputRef.current?.(data);
      }
    });
    source.addEventListener("stderr", (event) => {
      const data = (event as MessageEvent<string>).data;
      term.write(data);
      if (dependencySetupRef.current?.sessionId === activeId) {
        finishDependencySetup(activeId, data);
      } else {
        outputRef.current?.(data);
      }
    });
    source.addEventListener("exit", () => {
      if (activeSessionRef.current?.id === activeId) {
        activeSessionRef.current = { ...activeSessionRef.current, status: "exited" };
      }
      if (dependencySetupRef.current?.sessionId === activeId) {
        dependencySetupRef.current = null;
        setupRunningRef.current = false;
        setSetupRunning(false);
        setSetupMessage("PowerShell exited before dependency setup completed. Reopen Terminal to start a fresh shell.");
      }
      onSessionEnd?.(activeId);
      void loadSessions();
    });
    source.addEventListener("snapshot", (event) => {
      const data = (event as MessageEvent<string>).data;
      try {
        const parsed = JSON.parse(data) as { status?: string };
        if (parsed.status !== "running") {
          if (activeSessionRef.current?.id === activeId) {
            activeSessionRef.current = { ...activeSessionRef.current, status: "exited" };
          }
          onSessionEnd?.(activeId);
          void loadSessions();
        }
      } catch {
        // A malformed snapshot is not worth stopping for.
      }
    });

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [activeId, finishDependencySetup, loadSessions, onSessionEnd]);

  // Keep the terminal the right size, and tell the session about it.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (term === null || fit === null) return;

    const apply = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = activeIdRef.current;
      if (id === null) return;
      void fetch(`/api/terminal/${encodeURIComponent(id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => undefined);
    };

    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [activeId]);

  // When the pane opens, fit the terminal to its box.
  useEffect(() => {
    const fit = fitRef.current;
    if (fit === null) return;
    const timer = window.setTimeout(() => {
      try {
        fit.fit();
      } catch {
        // The box may not be laid out yet.
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [sessions.length]);

  async function startSession(event: React.FormEvent) {
    event.preventDefault();
    const text = command.trim();
    if (text === "") return;

    setBusy(true);
    setError(null);
    try {
      const currentShell = activeSessionRef.current;
      if (
        currentShell?.id === activeId &&
        currentShell.status === "running" &&
        currentShell.command === "shell"
      ) {
        await sendToSession(currentShell.id, `${text}\r`);
        return;
      }

      // An interactive shell: the command is typed into it, so it stays usable afterwards.
      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: slug,
          command: "",
          interactive: true,
          confirm: true,
          pty: true,
          cols: termRef.current?.cols ?? DEFAULT_COLS,
          rows: termRef.current?.rows ?? DEFAULT_ROWS,
        }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        session?: TerminalSession;
        error?: string;
      };
      if (!response.ok || !body.ok || body.session === undefined) {
        throw new Error(body.error ?? "the session could not be started");
      }
      const session = body.session;
      selectSession(session);
      setSessions((current) => [...current.filter((entry) => entry.id !== session.id), session]);
      await loadSessions();

      // Give the shell a moment to print its prompt, then type the command.
      window.setTimeout(() => {
        void sendToSession(session.id, `${text}\r`);
      }, 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendToSession(id: string, text: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? "the command could not be sent");
      }
      setCommand("");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? "the session could not be stopped");
      }
      await loadSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? "the session could not be removed");
      }
      if (activeId === id) {
        activeSessionRef.current = null;
        setActiveId(null);
        onSessionChange(null);
      }
      await loadSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const active = sessions.find((session) => session.id === activeId) ?? null;

  return (
    <div className="terminal-pane">
      <div className="terminal-screen" ref={hostRef} />

      <div className="terminal-footer">
        <form className="terminal-command" onSubmit={startSession}>
          <span className="terminal-prompt" aria-hidden="true">
            &gt;
          </span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={`Run a command in ${slug}…`}
            aria-label="Command"
            disabled={busy || setupRunning}
          />
          <button type="submit" className="primary" disabled={busy || setupRunning || command.trim() === ""}>
            Run
          </button>
        </form>

        <div className="terminal-sessions">
          {sessions.length === 0 && <span className="meta">No sessions yet.</span>}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={session.id === activeId ? "terminal-session active" : "terminal-session"}
            >
              <button
                type="button"
                className="terminal-session-name"
                disabled={setupRunning}
                onClick={() => selectSession(session)}
                title={session.command}
              >
                <span className={`job-status ${session.status}`}>{session.status}</span>
                <span className="terminal-session-command">{session.command}</span>
              </button>
              {session.status === "running" ? (
                <button
                  type="button"
                  onClick={() => void cancel(session.id)}
                  disabled={busy}
                  title="Stop this session"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void remove(session.id)}
                  disabled={busy || setupRunning}
                  title="Remove this session"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        {active !== null && (
          <p className="meta">
            {active.cwd} · {active.status}
          </p>
        )}
        <p className="meta">
          {setupMessage ?? "Enter your run command below and click Run (for example: python your_script.py or npm run dev)."}
        </p>
        {error !== null && <p className="notice bad">{error}</p>}
      </div>
    </div>
  );
}
