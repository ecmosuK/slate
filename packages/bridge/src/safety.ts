/**
 * Path safety rails for the bridge.
 */

import { resolve, sep } from "node:path";

const REFUSED_PREFIXES_WIN = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"];
const REFUSED_ROOTS = new Set(["", "\\", "/"]);

export function normalizePath(path: string): string {
  return resolve(path);
}

export function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep) || t.startsWith(r + "/");
}

export function isDriveRoot(path: string): boolean {
  const resolved = resolve(path);
  return /^[A-Za-z]:\\?$/.test(resolved) || resolved === "/" || resolved === "\\";
}

export function isRefusedPath(path: string): boolean {
  const resolved = resolve(path);
  if (isDriveRoot(resolved)) return true;
  const upper = resolved.toUpperCase();
  for (const prefix of REFUSED_PREFIXES_WIN) {
    if (upper === prefix.toUpperCase() || upper.startsWith(prefix.toUpperCase() + "\\")) return true;
  }
  // Common Unix sensitive roots.
  if (resolved === "/etc" || resolved.startsWith("/etc/")) return true;
  if (resolved === "/proc" || resolved.startsWith("/proc/")) return true;
  return false;
}

export function isAllowedPath(target: string, allowlistRoot: string): boolean {
  if (isRefusedPath(target)) return false;
  if (isRefusedPath(allowlistRoot)) return false;
  return isInside(allowlistRoot, target);
}

export function assertSafePath(target: string, allowlistRoot?: string): void {
  if (isRefusedPath(target)) throw new Error(`refused path: ${target}`);
  if (allowlistRoot !== undefined && !isInside(allowlistRoot, target)) {
    throw new Error(`path outside allowlist: ${target}`);
  }
}

export function isIgnoredPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.includes("/.git/") ||
    normalized.endsWith("/.git") ||
    normalized.includes("/node_modules/") ||
    normalized.endsWith("/node_modules") ||
    normalized.includes("/slate:ignore")
  );
}

export const isSafePath = isAllowedPath;
export const validatePath = assertSafePath;
export const checkPath = assertSafePath;
export const ensureSafePath = assertSafePath;