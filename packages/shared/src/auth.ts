/**
 * Passwords, session tokens and roles.
 *
 * Nothing here touches the network or the disk: the web app and the tests call the same functions.
 * Passwords are stored as a self-describing scrypt record so the parameters can be raised later
 * without a migration — a verifier reads the cost out of the record it is given.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** Thirty days: long enough to stay signed in, short enough to expire a stolen cookie. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT = {
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
  saltLength: 16,
} as const;

const SCRYPT_RECORD = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Buffer {
  // NFKC keeps a password typed on one keyboard equal to the same password pasted from another.
  return scryptSync(password.normalize("NFKC"), salt, SCRYPT.keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
  });
}

/** `scrypt$N$r$p$salt$hash`, base64url without padding. */
export function hashPassword(password: string, salt: Buffer = randomBytes(SCRYPT.saltLength)): string {
  const hash = derive(password, salt, SCRYPT.cost, SCRYPT.blockSize, SCRYPT.parallelization);
  const encode = (buffer: Buffer) => buffer.toString("base64url");
  return [
    "scrypt",
    SCRYPT.cost,
    SCRYPT.blockSize,
    SCRYPT.parallelization,
    encode(salt),
    encode(hash),
  ].join("$");
}

/** Constant-time check. A missing or malformed record is a failed check, never a thrown error. */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (stored === null) return false;
  const match = SCRYPT_RECORD.exec(stored);
  if (match === null) return false;

  const [, cost, blockSize, parallelization, salt, expected] = match;
  if (
    cost === undefined ||
    blockSize === undefined ||
    parallelization === undefined ||
    salt === undefined ||
    expected === undefined
  ) {
    return false;
  }

  try {
    const derived = derive(
      password,
      Buffer.from(salt, "base64url"),
      Number(cost),
      Number(blockSize),
      Number(parallelization),
    );
    const wanted = Buffer.from(expected, "base64url");
    if (wanted.length !== derived.length) return false;
    return timingSafeEqual(derived, wanted);
  } catch {
    return false;
  }
}

/** Why a password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if (password.trim() === "") return "choose a password";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `use at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `use at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Why an email address is unacceptable, or null when it is fine. */
export function emailProblem(email: string): string | null {
  const normalised = normaliseEmail(email);
  if (normalised === "") return "enter an email address";
  if (normalised.length > 254) return "that email address is too long";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) {
    return "that does not look like an email address";
  }
  return null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** A bearer token for a session cookie, plus the hash that is safe to store. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function sessionExpiresAt(now: Date = new Date(), ttlMs: number = SESSION_TTL_MS): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function sessionExpired(expiresAt: string, now: Date = new Date()): boolean {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() >= at;
}

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = ["read", "write", "manage", "admin"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const GRANTS: Record<Role, readonly Capability[]> = {
  owner: ["read", "write", "manage", "admin"],
  editor: ["read", "write"],
  viewer: ["read"],
};

/** Whether a role may do something. No role means no permission at all. */
export function can(role: Role | null, capability: Capability): boolean {
  if (role === null) return false;
  return GRANTS[role].includes(capability);
}
