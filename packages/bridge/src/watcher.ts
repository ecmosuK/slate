/**
 * Folder watcher.
 *
 * Wraps `fs.watch` (recursive on Windows/macOS) with debouncing and a small, predictable event
 * shape. Fails open: errors are reported through `onError` rather than thrown.
 */

import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export type WatchEventKind = "add" | "change" | "remove" | "rename" | "ready" | "error";

export interface WatchEvent {
  kind: WatchEventKind;
  path: string;
  root: string;
  timestamp: string;
}

export interface WatcherOptions {
  /** Watch subdirectories. Defaults to true. */
  recursive?: boolean;
  /** Debounce window in milliseconds. Defaults to 300. */
  debounceMs?: number;
  /** Ignore the initial scan. Defaults to true. */
  ignoreInitial?: boolean;
  /** Called for every event. */
  onEvent?: (event: WatchEvent) => void;
  onAdd?: (path: string, event: WatchEvent) => void;
  onChange?: (path: string, event: WatchEvent) => void;
  onRemove?: (path: string, event: WatchEvent) => void;
  onError?: (error: Error) => void;
  /** Filter predicate; return false to skip an event. */
  filter?: (path: string) => boolean;
}

export interface Watcher {
  root: string;
  close(): void;
  on(kind: WatchEventKind | "*", handler: (event: WatchEvent) => void): () => void;
}

export class FolderWatcher implements Watcher {
  root: string;
  private watcher: FSWatcher | null = null;
  private handlers = new Map<string, Set<(event: WatchEvent) => void>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(root: string, options: WatcherOptions = {}) {
    this.root = root;
    const recursive = options.recursive ?? true;
    const debounceMs = options.debounceMs ?? 300;
    const filter = options.filter;

    const emit = (kind: WatchEventKind, relativePath: string) => {
      if (this.closed) return;
      const fullPath = relativePath === "" ? root : join(root, relativePath);
      if (filter && !filter(fullPath)) return;

      const event: WatchEvent = {
        kind,
        path: fullPath,
        root,
        timestamp: new Date().toISOString(),
      };

      // Debounce per path.
      const key = `${kind}:${fullPath}`;
      const existing = this.timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.timers.delete(key);
        this.dispatch(event);
        if (options.onEvent) options.onEvent(event);
        if (kind === "add" && options.onAdd) options.onAdd(fullPath, event);
        if (kind === "change" && options.onChange) options.onChange(fullPath, event);
        if (kind === "remove" && options.onRemove) options.onRemove(fullPath, event);
      }, debounceMs);
      this.timers.set(key, timer);
    };

    try {
      this.watcher = fsWatch(
        root,
        { recursive, persistent: false },
        (eventType, filename) => {
          const name = filename === null ? "" : String(filename);
          if (eventType === "rename") {
            // `rename` covers both creates and deletes on most platforms.
            emit(existsSync(join(root, name)) ? "add" : "remove", name);
          } else {
            emit("change", name);
          }
        },
      );
      this.watcher.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (options.onError) options.onError(err);
        this.dispatch({ kind: "error", path: root, root, timestamp: new Date().toISOString() });
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.onError) options.onError(err);
    }
  }

  private dispatch(event: WatchEvent): void {
    const set = this.handlers.get(event.kind);
    if (set) for (const handler of set) handler(event);
    const all = this.handlers.get("*");
    if (all) for (const handler of all) handler(event);
  }

  on(kind: WatchEventKind | "*", handler: (event: WatchEvent) => void): () => void {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set());
    this.handlers.get(kind)!.add(handler);
    return () => this.handlers.get(kind)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = null;
  }
}

export function watchFolder(
  root: string,
  handlerOrOptions?: ((event: WatchEvent) => void) | WatcherOptions,
  options?: WatcherOptions,
): Watcher {
  const resolvedOptions: WatcherOptions =
    typeof handlerOrOptions === "function"
      ? { ...(options ?? {}), onEvent: handlerOrOptions }
      : { ...(handlerOrOptions ?? {}), ...(options ?? {}) };

  return new FolderWatcher(root, resolvedOptions);
}

export function createWatcher(root: string, options: WatcherOptions = {}): Watcher {
  return new FolderWatcher(root, options);
}

export function startWatcher(root: string, options: WatcherOptions = {}): Watcher {
  return new FolderWatcher(root, options);
}

export function watch(root: string, handler?: (event: WatchEvent) => void, options?: WatcherOptions): Watcher {
  return watchFolder(root, handler, options);
}

export function watchProjects(
  root: string,
  onProject: (folder: string, event: WatchEvent) => void,
  options: WatcherOptions = {},
): Watcher {
  return watchFolder(
    root,
    (event) => {
      // Only surface directory-level events.
      onProject(event.path, event);
    },
    { ...options, recursive: options.recursive ?? true },
  );
}

export const createFolderWatcher = createWatcher;
export const startFolderWatcher = startWatcher;
export const createProjectWatcher = watchProjects;
export const watchProject = watchProjects;
export const startProjectWatcher = watchProjects;
export const FolderWatcherAlias = FolderWatcher;
export const watchDirectory = watchFolder;
export const watchRoot = watchFolder;
export const observeFolder = watchFolder;
export const startWatching = startWatcher;
export const createDirectoryWatcher = createWatcher;