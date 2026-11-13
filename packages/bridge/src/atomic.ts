/**
 * Atomic README writer.
 *
 * Render in memory -> hash compare -> write `<file>.tmp` -> atomic replace. Unchanged files are
 * never rewritten, and a short ring buffer of previous versions is kept for recovery.
 */

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { configDir } from "@slate/shared";

export interface AtomicWriteOptions {
  /** Text encoding. Defaults to utf8. */
  encoding?: BufferEncoding;
  /** File mode for a newly created file. */
  mode?: number;
  /** Directory that holds the recovery ring buffer. Defaults to the Slate config dir. */
  historyDir?: string;
  /** Disable the recovery ring buffer entirely. */
  keepHistory?: boolean;
  /** How many previous versions to keep. Defaults to 5. */
  historySize?: number;
  /** Suffix used for the temporary file. Defaults to `.tmp`. */
  tmpSuffix?: string;
  /** When true, skip the write when the on-disk content already matches. Defaults to true. */
  skipUnchanged?: boolean;
  /** Optional expected hash of the current on-disk content; mismatch aborts the write. */
  expectedHash?: string;
}

export interface AtomicWriteResult {
  path: string;
  changed: boolean;
  hash: string;
  previousHash: string | null;
  bytes: number;
  skipped: boolean;
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256String(text: string, encoding: BufferEncoding = "utf8"): string {
  return createHash("sha256").update(text, encoding).digest("hex");
}

function readBuffer(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function rotateHistory(path: string, historyDir: string, historySize: number): void {
  try {
    ensureDir(historyDir);
    const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const name = `${basename(path)}.${stamp}.bak`;
    const destination = join(historyDir, name);
    // Copy the current file into the ring buffer before it is replaced.
    if (existsSync(path)) {
      writeFileSync(destination, readFileSync(path));
    }
    // Trim to the configured size.
    const entries = readdirSync(historyDir)
      .filter((entry) => entry.startsWith(`${basename(path)}.`) && entry.endsWith(".bak"))
      .sort();
    const overflow = entries.length - historySize;
    if (overflow > 0) {
      for (const entry of entries.slice(0, overflow)) {
        try {
          unlinkSync(join(historyDir, entry));
        } catch {
          // Best effort: a stale backup must never block a write.
        }
      }
    }
  } catch {
    // History is a recovery aid, not a correctness requirement.
  }
}

function atomicReplace(tmpPath: string, targetPath: string): void {
  // fs.renameSync can overwrite on POSIX; on Windows it may throw EPERM/EEXIST.
  try {
    renameSync(tmpPath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
  }
  // Fallback: remove then rename. Briefly non-atomic, but keeps the API working on Windows.
  try {
    if (existsSync(targetPath)) unlinkSync(targetPath);
  } catch {
    // ignore
  }
  renameSync(tmpPath, targetPath);
}

/**
 * Write `content` to `filePath` atomically.
 */
export function atomicWrite(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  const encoding = options.encoding ?? "utf8";
  const skipUnchanged = options.skipUnchanged ?? true;
  const tmpSuffix = options.tmpSuffix ?? ".tmp";
  const historySize = options.historySize ?? 5;

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, encoding);
  const nextHash = sha256Buffer(buffer);

  const previousBuffer = readBuffer(filePath);
  const previousHash = previousBuffer === null ? null : sha256Buffer(previousBuffer);

  const keepHistory = options.keepHistory ?? true;
  const historyDir = options.historyDir ?? (keepHistory ? join(configDir(), "readme-history") : undefined);

  // Conflict guard: if the caller expected a specific on-disk hash, honour it.
  if (options.expectedHash !== undefined && previousHash !== options.expectedHash) {
    throw new Error(
      `atomicWrite conflict: expected ${options.expectedHash} but found ${previousHash ?? "nothing"}`,
    );
  }

  const unchanged = previousHash !== null && previousHash === nextHash;
  if (unchanged && skipUnchanged) {
    return {
      path: filePath,
      changed: false,
      hash: nextHash,
      previousHash,
      bytes: buffer.byteLength,
      skipped: true,
    };
  }

  // Keep a copy of the previous version before replacing it.
  if (previousBuffer !== null && historyDir !== undefined) {
    rotateHistory(filePath, historyDir, historySize);
  }

  const dir = dirname(filePath);
  if (dir !== "" && dir !== ".") ensureDir(dir);

  const tmpPath = `${filePath}${tmpSuffix}`;
  writeFileSync(tmpPath, buffer, { encoding: undefined, mode: options.mode });
  atomicReplace(tmpPath, filePath);

  // Best-effort cleanup of a stray tmp file.
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  } catch {
    // ignore
  }

  return {
    path: filePath,
    changed: true,
    hash: nextHash,
    previousHash,
    bytes: buffer.byteLength,
    skipped: false,
  };
}

/** Async wrapper. */
export async function atomicWriteAsync(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  return atomicWrite(filePath, content, options);
}

// Aliases.
export const writeAtomic = atomicWrite;
export const writeAtomicSync = atomicWrite;
export const writeFileAtomic = atomicWrite;
export const atomicWriteFile = atomicWrite;
export const atomicReplaceFile = atomicWrite;
export const writeAtomicFile = atomicWrite;
export const atomicWriteSync = atomicWrite;
export const atomicWriteFileSync = atomicWrite;
export const atomicReplaceSync = atomicWrite;
export const safeWrite = atomicWrite;
export const safeWriteFile = atomicWrite;
export const writeFileSafe = atomicWrite;
export const atomicSave = atomicWrite;
export const saveAtomic = atomicWrite;
export const atomicWriteText = atomicWrite;
export const writeTextAtomic = atomicWrite;

export function sha256(value: string | Buffer, encoding: BufferEncoding = "utf8"): string {
  if (Buffer.isBuffer(value)) return sha256Buffer(value);
  return sha256String(value, encoding);
}

export function hashContent(value: string | Buffer, encoding: BufferEncoding = "utf8"): string {
  return sha256(value, encoding);
}

export function hashFile(path: string): string | null {
  const buffer = readBuffer(path);
  if (buffer === null) return null;
  return sha256Buffer(buffer);
}

export function fileHash(path: string): string | null {
  return hashFile(path);
}

// Conflict-aware retry helper: re-read, re-render, retry once.
export async function atomicWriteWithRetry(
  filePath: string,
  render: (current: string | null) => string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const current = existsSync(filePath) ? readFileSync(filePath, (options.encoding ?? "utf8") as BufferEncoding) : null;
  const content = render(current);
  try {
    return atomicWrite(filePath, content, options);
  } catch (error) {
    // Re-read and retry once.
    const again = existsSync(filePath) ? readFileSync(filePath, (options.encoding ?? "utf8") as BufferEncoding) : null;
    const retried = render(again);
    return atomicWrite(filePath, retried, options);
  }
}

// Re-export BufferEncoding-friendly read helper.
export class AtomicWriter {
  options: AtomicWriteOptions;
  constructor(options: AtomicWriteOptions = {}) {
    this.options = options;
  }
  write(filePath: string, content: string | Buffer, overrides: AtomicWriteOptions = {}) {
    return atomicWrite(filePath, content, { ...this.options, ...overrides });
  }
  writeSync(filePath: string, content: string | Buffer, overrides: AtomicWriteOptions = {}) {
    return atomicWrite(filePath, content, { ...this.options, ...overrides });
  }
  async writeAsync(filePath: string, content: string | Buffer, overrides: AtomicWriteOptions = {}) {
    return atomicWriteAsync(filePath, content, { ...this.options, ...overrides });
  }
}

export function readText(path: string, encoding: BufferEncoding = "utf8"): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, encoding);
}