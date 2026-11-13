/**
 * Pseudo-terminal support for the terminal runner.
 *
 * A PTY is what makes a terminal a terminal: the shell believes it is talking to a console, so it
 * echoes what you type, draws with colours and cursor movement, and reacts to Ctrl+C. Pipes
 * cannot do any of that.
 *
 * node-pty is a native addon, so it is loaded lazily and a failure to load it is remembered. The
 * caller then falls back to plain pipes instead of the whole pane disappearing.
 */

import { createRequire as nodeCreateRequire } from "node:module";
import { join } from "node:path";

export interface PtyHandle {
  /** Write to the session's input. */
  write(data: string): void;
  /** Tell the session the window changed size. */
  resize(cols: number, rows: number): void;
  /** Stop the session. */
  kill(): void;
  /** Called with everything the session writes. */
  onData(listener: (data: string) => void): void;
  /** Called when the session ends. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** Choose WinPTY when the detached Windows web process cannot attach to ConPTY. */
  useConpty?: boolean;
}

export type PtySpawn = (command: string, args: readonly string[], options: PtyOptions) => PtyHandle;

let ptyImpl: PtySpawn | null = null;
let loadError: string | null = null;

/** Replace the pseudo-terminal spawner. Pass null to restore the real one. */
export function setPtySpawn(fn: PtySpawn | null): void {
  ptyImpl = fn;
  loadError = null;
}

/** Why the pseudo-terminal could not be loaded, when it could not be. */
export function ptyUnavailableReason(): string | null {
  return loadError;
}

interface NativePty {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      useConpty?: boolean;
    },
  ) => {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  };
}

/**
 * A `require` that can load a native module.
 *
 * The bundler replaces the imported `createRequire` with a stub, so the real one is taken from
 * the running process instead. `process.getBuiltinModule` reaches Node's own module loader
 * without going through the bundle at all.
 */
function makeRequire(base: string): NodeRequire {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule;
  if (typeof getBuiltin === "function") {
    const builtin = getBuiltin("module") as
      | { createRequire?: (id: string) => NodeRequire }
      | undefined;
    if (typeof builtin?.createRequire === "function") {
      return builtin.createRequire(base);
    }
  }
  return nodeCreateRequire(base);
}

function loadNativePty(): NativePty {
  // The bundle rewrites `import.meta.url`, so the module cannot always be resolved from here.
  // Try the module's own location first, then the working directory the app was started in;
  // both walk up to the folder that holds node_modules.
  const bases: string[] = [];
  if (typeof import.meta.url === "string" && import.meta.url.startsWith("file:")) {
    bases.push(import.meta.url);
  }
  bases.push(join(process.cwd(), "package.json"));

  let lastError: unknown = null;
  const tried: string[] = [];
  for (const base of bases) {
    tried.push(base);
    try {
      return makeRequire(base)("node-pty") as NativePty;
    } catch (error) {
      lastError = error;
    }
  }
  const detail =
    lastError instanceof Error
      ? `${lastError.message} | ${lastError.stack ?? ""}`
      : String(lastError);
  throw new Error(`node-pty could not be loaded from ${tried.join(", ")}: ${detail}`);
}

/**
 * The real pseudo-terminal spawner.
 *
 * Throws when node-pty cannot be loaded, so the caller can fall back to pipes.
 */
export function spawnPty(
  command: string,
  args: readonly string[],
  options: PtyOptions,
): PtyHandle {
  if (ptyImpl !== null) return ptyImpl(command, args, options);

  let native: NativePty;
  try {
    native = loadNativePty();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    throw new Error(`a pseudo-terminal is not available: ${loadError}`);
  }

  ptyImpl = (cmd, cmdArgs, opts) => {
    let child: ReturnType<NativePty["spawn"]>;
    try {
      child = native.spawn(cmd, [...cmdArgs], {
        name: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
        ...(opts.useConpty === undefined ? {} : { useConpty: opts.useConpty }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      throw new Error(`the pseudo-terminal could not start: ${message} | ${stack}`);
    }
    return {
      write: (data: string) => child.write(data),
      resize: (cols: number, rows: number) => child.resize(cols, rows),
      kill: () => child.kill(),
      onData: (listener: (data: string) => void) => child.onData(listener),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) =>
        child.onExit(listener),
    };
  };

  return ptyImpl(command, args, options);
}
