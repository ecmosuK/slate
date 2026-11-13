import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_NAME,
  EMPTY_WORKSPACE_STATE,
  LOCAL_OWNER_EMAIL,
  SESSION_TTL_MS,
  WorkspaceError,
  activeWorkspace,
  addMember,
  coerceWorkspaceState,
  createUser,
  createWorkspace,
  endSession,
  ensureLocalSetup,
  identify,
  membershipOf,
  passwordRequired,
  pruneSessions,
  readWorkspaceState,
  renameWorkspace,
  setActiveWorkspace,
  setPassword,
  signIn,
  startSession,
  workspaceStatePath,
  workspacesFor,
  writeWorkspaceState,
  type WorkspaceState,
} from "@slate/shared";

const roots: string[] = [];
const NOW = new Date("2026-11-11T10:00:00.000Z");

function booted(): WorkspaceState {
  return ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW).state;
}

function withPassword(state: WorkspaceState, password = "a good password"): WorkspaceState {
  const user = state.users[0];
  if (user === undefined) throw new Error("no user");
  const result = setPassword(state, user.id, password);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

beforeEach(() => {
  roots.length = 0;
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureLocalSetup", () => {
  it("creates the local owner and one workspace on first run", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    expect(setup.created).toBe(true);
    expect(setup.user.email).toBe(LOCAL_OWNER_EMAIL);
    expect(setup.user.passwordHash).toBeNull();
    expect(setup.workspace.name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(setup.state.activeWorkspaceId).toBe(setup.workspace.id);
    expect(membershipOf(setup.state, setup.workspace.id, setup.user.id)?.role).toBe("owner");
  });

  it("is idempotent", () => {
    const once = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const twice = ensureLocalSetup(once.state, NOW);
    expect(twice.created).toBe(false);
    expect(twice.state.users).toHaveLength(1);
    expect(twice.state.workspaces).toHaveLength(1);
    expect(twice.state.members).toHaveLength(1);
  });

  it("repairs a missing membership", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const broken: WorkspaceState = { ...setup.state, members: [] };
    const repaired = ensureLocalSetup(broken, NOW);
    expect(repaired.created).toBe(true);
    expect(membershipOf(repaired.state, setup.workspace.id, setup.user.id)?.role).toBe("owner");
  });
});

describe("workspaces", () => {
  it("adds the creator as owner and makes it active", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const result = createWorkspace(setup.state, {
      name: "  Work ",
      ownerId: setup.user.id,
      now: NOW,
    });
    expect(result.workspace.name).toBe("Work");
    expect(result.state.activeWorkspaceId).toBe(result.workspace.id);
    expect(membershipOf(result.state, result.workspace.id, setup.user.id)?.role).toBe("owner");
    expect(workspacesFor(result.state, setup.user.id).map((entry) => entry.name)).toEqual([
      DEFAULT_WORKSPACE_NAME,
      "Work",
    ]);
  });

  it("refuses a blank or duplicate name", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    expect(() => createWorkspace(setup.state, { name: "  ", ownerId: setup.user.id })).toThrow(
      WorkspaceError,
    );
    expect(() =>
      createWorkspace(setup.state, { name: DEFAULT_WORKSPACE_NAME.toLowerCase(), ownerId: setup.user.id }),
    ).toThrow(/already exists/);
  });

  it("renames, and leaves the old name free for someone else", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const renamed = renameWorkspace(setup.state, setup.workspace.id, "Archive");
    expect(renamed.workspaces[0]?.name).toBe("Archive");
    expect(renameWorkspace(renamed, setup.workspace.id, "Archive")).toBe(renamed);
  });

  it("switches the active workspace only to one that exists", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const created = createWorkspace(setup.state, { name: "Work", ownerId: setup.user.id, now: NOW });
    const back = setActiveWorkspace(created.state, setup.workspace.id);
    expect(activeWorkspace(back)?.id).toBe(setup.workspace.id);
    expect(() => setActiveWorkspace(created.state, "nowhere")).toThrow(WorkspaceError);
  });

  it("adds a member once", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    const created = createUser(setup.state, { email: "friend@example.com", now: NOW });
    const joined = addMember(created.state, {
      workspaceId: setup.workspace.id,
      userId: created.user.id,
      role: "viewer",
      now: NOW,
    });
    const again = addMember(joined, {
      workspaceId: setup.workspace.id,
      userId: created.user.id,
      role: "editor",
      now: NOW,
    });
    expect(again.members).toHaveLength(2);
    expect(membershipOf(again, setup.workspace.id, created.user.id)?.role).toBe("viewer");
  });
});

describe("accounts", () => {
  it("rejects a duplicate email and a weak password", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    expect(() => createUser(setup.state, { email: LOCAL_OWNER_EMAIL })).toThrow(/already exists/);
    expect(() => createUser(setup.state, { email: "new@example.com", password: "short" })).toThrow(
      WorkspaceError,
    );
  });

  it("unlocks the machine again when the password is cleared", () => {
    const setup = ensureLocalSetup(EMPTY_WORKSPACE_STATE, NOW);
    expect(passwordRequired(setup.state)).toBe(false);

    const locked = withPassword(setup.state);
    expect(passwordRequired(locked)).toBe(true);
    expect(identify(locked, null, NOW)).toBeNull();

    const unlocked = setPassword(locked, setup.user.id, null);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) expect(identify(unlocked.state, null, NOW)?.user.id).toBe(setup.user.id);
  });
});

describe("sessions", () => {
  it("trusts the local owner while no password is set", () => {
    const state = booted();
    const identity = identify(state, null, NOW);
    expect(identity?.user.email).toBe(LOCAL_OWNER_EMAIL);
    expect(identity?.role).toBe("owner");
    expect(identity?.session).toBeNull();
  });

  it("needs a password once one is set, and then a live session", () => {
    const locked = withPassword(booted());
    expect(identify(locked, null, NOW)).toBeNull();

    const signedIn = signIn(locked, {
      email: LOCAL_OWNER_EMAIL,
      password: "a good password",
      now: NOW,
    });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;

    expect(identify(signedIn.state, signedIn.token, NOW)?.user.id).toBe(signedIn.user.id);
    expect(identify(signedIn.state, signedIn.token, NOW)?.workspace?.name).toBe(
      DEFAULT_WORKSPACE_NAME,
    );

    const signedOut = endSession(signedIn.state, signedIn.token);
    expect(identify(signedOut, signedIn.token, NOW)).toBeNull();
  });

  it("refuses a wrong password, an unknown email and an account without one", () => {
    const locked = withPassword(booted());
    expect(signIn(locked, { email: LOCAL_OWNER_EMAIL, password: "nope", now: NOW })).toEqual({
      ok: false,
      error: "wrong password",
    });
    expect(signIn(locked, { email: "nobody@example.com", password: "x", now: NOW })).toEqual({
      ok: false,
      error: "no account with that email",
    });

    const created = createUser(locked, { email: "nobody@example.com", now: NOW });
    expect(signIn(created.state, { email: "nobody@example.com", password: "x", now: NOW })).toEqual({
      ok: false,
      error: "that account has no password",
    });
  });

  it("stops honouring a session once it expires", () => {
    const locked = withPassword(booted());
    const signedIn = signIn(locked, {
      email: LOCAL_OWNER_EMAIL,
      password: "a good password",
      now: NOW,
    });
    if (!signedIn.ok) throw new Error(signedIn.error);

    const later = new Date(NOW.getTime() + SESSION_TTL_MS + 1000);
    expect(identify(signedIn.state, signedIn.token, later)).toBeNull();
    expect(identify(signedIn.state, signedIn.token, NOW)).not.toBeNull();
    expect(pruneSessions(signedIn.state, later).removed).toBe(1);
  });

  it("never stores the token itself", () => {
    const state = booted();
    const user = state.users[0];
    if (user === undefined) throw new Error("no user");
    const started = startSession(state, { userId: user.id, now: NOW });
    expect(JSON.stringify(started.state)).not.toContain(started.token);
  });
});

describe("the state file", () => {
  it("round-trips and lives beside the config", () => {
    const root = mkdtempSync(join(tmpdir(), "slate-workspace-"));
    roots.push(root);
    const path = workspaceStatePath(root);
    expect(path.endsWith("workspace.json")).toBe(true);

    const state = booted();
    writeWorkspaceState(state, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("a good password");
    expect(readWorkspaceState(path).workspaces[0]?.name).toBe(DEFAULT_WORKSPACE_NAME);
  });

  it("does not crash on a damaged file", () => {
    const root = mkdtempSync(join(tmpdir(), "slate-workspace-"));
    roots.push(root);
    const path = workspaceStatePath(root);
    writeFileSync(path, "}{");
    expect(readWorkspaceState(path)).toEqual(EMPTY_WORKSPACE_STATE);
  });

  it("keeps the entries it recognises and drops the rest", () => {
    const state = coerceWorkspaceState({
      version: 1,
      users: [{ id: "u1", email: "Owner@Slate.Local" }, { nope: true }],
      workspaces: [{ id: "w1", name: "Personal", ownerId: "u1" }, "junk"],
      members: [{ workspaceId: "w1", userId: "u1", role: "owner" }, { workspaceId: "w1", userId: "u1", role: "king" }],
      sessions: [{ id: "s1", userId: "u1", tokenHash: "h", expiresAt: "2030-01-01T00:00:00.000Z" }],
      activeWorkspaceId: "gone",
    });
    expect(state.users).toHaveLength(1);
    expect(state.users[0]?.email).toBe("owner@slate.local");
    expect(state.workspaces).toHaveLength(1);
    expect(state.members).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.activeWorkspaceId).toBeNull();
  });
});
