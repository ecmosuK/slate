/**
 * A small static file server, so a project can be seen before it has any tooling.
 *
 * The server serves the project's real files over HTTP with no rewriting, which is the point: what
 * the preview shows is what a static host would serve, so a project can be moved to a real
 * website without changing anything.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import { isInside, isRefusedPath } from "./safety.ts";

export type PreviewStatus = "running" | "stopped";

export class PreviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PreviewError";
    this.status = status;
  }
}

export interface PreviewSummary {
  id: string;
  project: string | null;
  /** The folder being served. */
  folder: string;
  /** The port the server listens on. */
  port: number;
  status: PreviewStatus;
  createdAt: string;
  stoppedAt: string | null;
  error: string | null;
}

/** The content types a browser needs to render a page properly. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

/** The content type for a file, by extension. */
export function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/** True when the path has a file extension, so it is a file and not a route. */
function looksLikeFile(path: string): boolean {
  return extname(path) !== "";
}

export interface ResolvedPreviewFile {
  /** The file to send, or null when the request cannot be answered. */
  file: string | null;
  /** The status to answer with when there is no file. */
  status: 200 | 403 | 404;
}

/**
 * Work out which file answers a request.
 *
 * A directory becomes its `index.html`; a path with no extension falls back to `index.html`, so a
 * single-page app keeps working on a deep link.
 */
export function resolvePreviewFile(
  folder: string,
  urlPath: string,
  options: { spaFallback?: boolean } = {},
): ResolvedPreviewFile {
  const root = resolve(folder);
  const segments = splitPathSegments(safeDecode(urlPath));

  // A `..` segment means the client asked to climb out of the folder: refuse it outright.
  if (segments === null) {
    return { file: null, status: 403 };
  }

  const relative = segments.join("/");
  // Never leave the folder: a request may not climb out of it. Checking the joined path keeps a
  // sneaky `/a/../../b` from being normalised away before we get a say.
  const candidate = resolve(root, relative);
  if (!isInside(root, candidate) || isRefusedPath(candidate)) {
    return { file: null, status: 403 };
  }

  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) {
        const index = join(candidate, "index.html");
        if (existsSync(index)) return { file: index, status: 200 };
        return { file: null, status: 404 };
      }
      return { file: candidate, status: 200 };
    } catch {
      return { file: null, status: 404 };
    }
  }

  // A route with no extension: hand back the entry page if there is one.
  if (relative === "" || !looksLikeFile(relative)) {
    if (options.spaFallback ?? true) {
      const index = join(root, "index.html");
      if (existsSync(index)) return { file: index, status: 200 };
    }
  }

  return { file: null, status: 404 };
}

/**
 * Split a request path into clean segments, refusing any that would climb out of the root.
 *
 * `..` segments are resolved against the segments gathered so far, so `/a/../../b` cannot smuggle
 * past the containment check the way `normalize` sometimes lets absolute paths do.
 */
function splitPathSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const raw of path.split(/[/\\]/)) {
    const segment = raw.trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      if (segments.length === 0) return null;
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

interface PreviewEntry {
  record: PreviewSummary;
  server: Server | null;
}

const store = globalThis as unknown as {
  __slatePreviews?: Map<string, PreviewEntry>;
};
const previews = store.__slatePreviews ?? new Map<string, PreviewEntry>();
store.__slatePreviews = previews;

function publicSummary(record: PreviewSummary): PreviewSummary {
  return { ...record };
}

/**
 * Serve a folder over HTTP and start listening.
 *
 * The port is chosen by the operating system, so two previews never collide.
 */
export async function startPreview(input: {
  folder: string;
  project?: string | null;
  port?: number;
  spaFallback?: boolean;
  /** When set, the folder must resolve inside this root, or the start is refused. */
  allowlistRoot?: string;
}): Promise<PreviewSummary> {
  const folder = resolve(input.folder);
  if (!existsSync(folder)) throw new PreviewError("the project folder does not exist", 404);
  if (isRefusedPath(folder)) throw new PreviewError(`refused path: ${folder}`, 403);
  if (input.allowlistRoot !== undefined && !isInside(input.allowlistRoot, folder)) {
    throw new PreviewError("the project folder is outside the allowed root", 403);
  }

  const record: PreviewSummary = {
    id: randomUUID(),
    project: input.project ?? null,
    folder,
    port: 0,
    status: "running",
    createdAt: new Date().toISOString(),
    stoppedAt: null,
    error: null,
  };
  const entry: PreviewEntry = { record, server: null };
  previews.set(record.id, entry);

  const server = createServer((request, response) => {
    const urlPath = (request.url ?? "/").split("?")[0] ?? "/";
    const resolved = resolvePreviewFile(folder, urlPath, {
      spaFallback: input.spaFallback ?? true,
    });
    if (resolved.file === null) {
      response.writeHead(resolved.status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(resolved.status === 403 ? "Forbidden" : "Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypeFor(resolved.file),
      "Cache-Control": "no-store",
    });
    createReadStream(resolved.file).pipe(response);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", (error) => {
      rejectPromise(
        new PreviewError(
          `the preview could not start: ${error instanceof Error ? error.message : String(error)}`,
          500,
        ),
      );
    });
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  record.port = typeof address === "object" && address !== null ? address.port : 0;
  entry.server = server;
  return publicSummary(record);
}

/** Every preview server, newest first. */
export function listPreviews(project?: string): PreviewSummary[] {
  const wanted = project === undefined ? null : project;
  return [...previews.values()]
    .map((entry) => publicSummary(entry.record))
    .filter((summary) => wanted === null || summary.project === wanted)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** One preview server by id, or null when it is unknown. */
export function getPreview(id: string): PreviewSummary | null {
  const entry = previews.get(id);
  return entry === undefined ? null : publicSummary(entry.record);
}

/** Stop a preview server and forget it. */
export function stopPreview(id: string): PreviewSummary {
  const entry = previews.get(id);
  if (entry === undefined) throw new PreviewError("preview not found", 404);
  entry.server?.close();
  entry.server = null;
  entry.record.status = "stopped";
  entry.record.stoppedAt = new Date().toISOString();
  const summary = publicSummary(entry.record);
  previews.delete(id);
  return summary;
}

/** Fail any preview whose server died, so a stale one does not sit in the list. */
export function reconcilePreviews(): void {
  for (const entry of [...previews.values()]) {
    if (entry.server !== null) continue;
    entry.record.status = "stopped";
    entry.record.stoppedAt = new Date().toISOString();
    entry.record.error = "the preview server stopped";
    previews.delete(entry.record.id);
  }
}

/** True when the folder holds something a browser can open. */
export function hasStaticEntry(folder: string): boolean {
  return staticEntryFolder(folder) !== null;
}

/** The folder a static preview should serve, or null when there is nothing to serve. */
export function staticEntryFolder(folder: string): string | null {
  const root = resolve(folder);
  for (const entry of ["public", "src", "dist", "build"]) {
    const nested = join(root, entry);
    if (existsSync(join(nested, "index.html"))) return nested;
  }
  if (existsSync(join(root, "index.html"))) return root;
  return null;
}
