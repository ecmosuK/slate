import { describe, expect, it } from "vitest";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_TTL_MS,
  can,
  emailProblem,
  hashPassword,
  hashToken,
  isRole,
  newSessionToken,
  normaliseEmail,
  passwordProblem,
  sessionExpired,
  sessionExpiresAt,
  verifyPassword,
} from "@slate/shared";
import { isUuidV7, uuidv7, uuidv7Time } from "@slate/shared";

describe("uuidv7", () => {
  it("is a valid version 7 uuid", () => {
    const id = uuidv7();
    expect(isUuidV7(id)).toBe(true);
    expect(id).toHaveLength(36);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("carries the millisecond it was made", () => {
    const now = Date.UTC(2026, 10, 11, 9, 30, 0);
    expect(uuidv7Time(uuidv7(now))).toBe(now);
  });

  it("sorts by time", () => {
    const early = uuidv7(1_000);
    const late = uuidv7(2_000);
    expect(early < late).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUuidV7("not-a-uuid")).toBe(false);
    expect(uuidv7Time("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("passwords", () => {
  it("verifies the password it hashed and nothing else", () => {
    const record = hashPassword("correct horse battery staple");
    expect(record.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", record)).toBe(true);
    expect(verifyPassword("correct horse battery stapl", record)).toBe(false);
    expect(verifyPassword("", record)).toBe(false);
  });

  it("salts every record", () => {
    const first = hashPassword("same password");
    const second = hashPassword("same password");
    expect(first).not.toBe(second);
    expect(verifyPassword("same password", first)).toBe(true);
    expect(verifyPassword("same password", second)).toBe(true);
  });

  it("treats a missing or damaged record as a failure", () => {
    expect(verifyPassword("anything", null)).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "plaintext")).toBe(false);
    expect(verifyPassword("anything", "scrypt$x$y$z$salt$hash")).toBe(false);
  });

  it("normalises unicode before hashing", () => {
    const record = hashPassword("café password");
    expect(verifyPassword("cafe\u0301 password", record)).toBe(true);
  });

  it("says why a password is unacceptable", () => {
    expect(passwordProblem("")).toBe("choose a password");
    expect(passwordProblem("   ")).toBe("choose a password");
    expect(passwordProblem("short")).toContain(String(PASSWORD_MIN_LENGTH));
    expect(passwordProblem("x".repeat(PASSWORD_MAX_LENGTH + 1))).toContain(
      String(PASSWORD_MAX_LENGTH),
    );
    expect(passwordProblem("eight-chars")).toBeNull();
  });
});

describe("emails", () => {
  it("lowercases and trims", () => {
    expect(normaliseEmail("  Owner@Slate.Local ")).toBe("owner@slate.local");
  });

  it("rejects obvious nonsense", () => {
    expect(emailProblem("")).toBe("enter an email address");
    expect(emailProblem("no-at-sign")).toContain("email address");
    expect(emailProblem("a@b")).toContain("email address");
    expect(emailProblem(`${"x".repeat(250)}@example.com`)).toContain("too long");
    expect(emailProblem("you@example.com")).toBeNull();
  });
});

describe("session tokens", () => {
  it("never stores the token it hands out", () => {
    const { token, tokenHash } = newSessionToken();
    expect(token.length).toBeGreaterThan(20);
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(hashToken(token));
  });

  it("expires a session after its lifetime", () => {
    const now = new Date("2026-11-11T00:00:00.000Z");
    const expiresAt = sessionExpiresAt(now);
    expect(Date.parse(expiresAt) - now.getTime()).toBe(SESSION_TTL_MS);
    expect(sessionExpired(expiresAt, new Date(now.getTime() + SESSION_TTL_MS - 1))).toBe(false);
    expect(sessionExpired(expiresAt, new Date(now.getTime() + SESSION_TTL_MS))).toBe(true);
  });

  it("treats an unreadable expiry as expired", () => {
    expect(sessionExpired("tomorrow")).toBe(true);
  });
});

describe("roles", () => {
  it("grants less as the role gets smaller", () => {
    expect(can("owner", "admin")).toBe(true);
    expect(can("owner", "manage")).toBe(true);
    expect(can("editor", "write")).toBe(true);
    expect(can("editor", "manage")).toBe(false);
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "write")).toBe(false);
    expect(can(null, "read")).toBe(false);
  });

  it("recognises only the three role names", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("editor")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
