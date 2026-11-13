/**
 * Local accounts, workspaces and sessions.
 *
 * Slate runs on one machine for one person and Postgres is not available yet, so the part of the
 * Drizzle schema that auth needs is kept in one JSON file beside the config. Everything below is a
 * pure function over `WorkspaceState`; only `readWorkspaceState` and `writeWorkspaceState` touch the
 * disk. That is what lets the tests cover locking, roles and expiry without a database.
 *
 * The file records users, workspaces, memberships and sessions — never a password or a raw token,
 * only an scrypt record and a SHA-256 of the token.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
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
  type Role,
} from "./auth.ts";
import { configDir } from "./config.ts";
import { uuidv7 } from "./ids.ts";

export const LOCAL_OWNER_EMAIL = "owner@slate.local";
export const LOCAL_OWNER_NAME = "Owner";
export const DEFAULT_WORKSPACE_NAME = "Personal";
export const WORKSPACE_NAME_MAX_LENGTH = 60;

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  /** Null while the machine is unlocked: no password means the local owner is trusted. */
  passwordHash: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface StoredWorkspace {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  createdAt: string;
}

export interface StoredMember {
  workspaceId: string;
  userId: string;
  role: Role;
  joinedAt: string;
}

export interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceState {
  version: 1;
  users: StoredUser[];
  workspaces: StoredWorkspace[];
  members: StoredMember[];
  sessions: StoredSession[];
  /** The workspace the app shows. One machine, one person, so it is not per session. */
  activeWorkspaceId: string | null;
}

export const EMPTY_WORKSPACE_STATE: WorkspaceState = {
  version: 1,
  users: [],
  workspaces: [],
  members: [],
  sessions: [],
  activeWorkspaceId: null,
};

export class WorkspaceError extends Error {}

export interface Identity {
  user: StoredUser;
  workspace: StoredWorkspace | null;
  role: Role | null;
  session: StoredSession | null;
}

/* ------------------------------------------------------------------------------------------------
 * Reading the file
 * ---------------------------------------------------------------------------------------------- */

export function workspaceStatePath(dir: string = configDir()): string {
  return join(dir, "workspace.json");
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const item = object(entry);
    if (item !== null) out.push(item);
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function coerceUser(value: Record<string, unknown>): StoredUser | null {
  const id = text(value["id"]);
  const email = text(value["email"]);
  if (id === null || email === null) return null;
  return {
    id,
    email: normaliseEmail(email),
    name: text(value["name"]) ?? email,
    passwordHash: text(value["passwordHash"]),
    createdAt: text(value["createdAt"]) ?? new Date(0).toISOString(),
    lastSeenAt: text(value["lastSeenAt"]),
  };
}

function coerceWorkspace(value: Record<string, unknown>): StoredWorkspace | null {
  const id = text(value["id"]);
  const name = text(value["name"]);
  const ownerId = text(value["ownerId"]);
  if (id === null || name === null || ownerId === null) return null;
  return {
    id,
    name,
    icon: text(value["icon"]),
    ownerId,
    createdAt: text(value["createdAt"]) ?? new Date(0).toISOString(),
  };
}

function coerceMember(value: Record<string, unknown>): StoredMember | null {
  const workspaceId = text(value["workspaceId"]);
  const userId = text(value["userId"]);
  const role = value["role"];
  if (workspaceId === null || userId === null || !isRole(role)) return null;
  return {
    workspaceId,
    userId,
    role,
    joinedAt: text(value["joinedAt"]) ?? new Date(0).toISOString(),
  };
}

function coerceSession(value: Record<string, unknown>): StoredSession | null {
  const id = text(value["id"]);
  const userId = text(value["userId"]);
  const tokenHash = text(value["tokenHash"]);
  const expiresAt = text(value["expiresAt"]);
  if (id === null || userId === null || tokenHash === null || expiresAt === null) return null;
  return {
    id,
    userId,
    tokenHash,
    userAgent: text(value["userAgent"]),
    ip: text(value["ip"]),
    createdAt: text(value["createdAt"]) ?? new Date(0).toISOString(),
    expiresAt,
  };
}

/** A previous or hand-edited file must never crash the app, so every field is checked. */
export function coerceWorkspaceState(value: unknown): WorkspaceState {
  const raw = object(value);
  if (raw === null) return { ...EMPTY_WORKSPACE_STATE };

  const users: StoredUser[] = [];
  for (const entry of objects(raw["users"])) {
    const user = coerceUser(entry);
    if (user !== null) users.push(user);
  }

  const workspaces: StoredWorkspace[] = [];
  for (const entry of objects(raw["workspaces"])) {
    const workspace = coerceWorkspace(entry);
    if (workspace !== null) workspaces.push(workspace);
  }

  const members: StoredMember[] = [];
  for (const entry of objects(raw["members"])) {
    const member = coerceMember(entry);
    if (member !== null) members.push(member);
  }

  const sessions: StoredSession[] = [];
  for (const entry of objects(raw["sessions"])) {
    const session = coerceSession(entry);
    if (session !== null) sessions.push(session);
  }

  const active = text(raw["activeWorkspaceId"]);
  return {
    version: 1,
    users,
    workspaces,
    members,
    sessions,
    activeWorkspaceId:
      active !== null && workspaces.some((workspace) => workspace.id === active) ? active : null,
  };
}

export function readWorkspaceState(path: string = workspaceStatePath()): WorkspaceState {
  if (!existsSync(path)) return { ...EMPTY_WORKSPACE_STATE };
  try {
    return coerceWorkspaceState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...EMPTY_WORKSPACE_STATE };
  }
}

export function writeWorkspaceState(
  state: WorkspaceState,
  path: string = workspaceStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }
}

/* ------------------------------------------------------------------------------------------------
 * Workspaces and membership
 * ---------------------------------------------------------------------------------------------- */

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new WorkspaceError("a workspace needs a name");
  if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new WorkspaceError(`use at most ${WORKSPACE_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

export function membershipOf(
  state: WorkspaceState,
  workspaceId: string,
  userId: string,
): StoredMember | null {
  return (
    state.members.find(
      (member) => member.workspaceId === workspaceId && member.userId === userId,
    ) ?? null
  );
}

export function workspacesFor(
  state: WorkspaceState,
  userId: string,
): Array<StoredWorkspace & { role: Role }> {
  const out: Array<StoredWorkspace & { role: Role }> = [];
  for (const workspace of state.workspaces) {
    const member = membershipOf(state, workspace.id, userId);
    if (member !== null) out.push({ ...workspace, role: member.role });
  }
  return out;
}

export function activeWorkspace(state: WorkspaceState): StoredWorkspace | null {
  if (state.activeWorkspaceId === null) return null;
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
}

export interface CreateWorkspaceOptions {
  name: string;
  ownerId: string;
  now?: Date;
  icon?: string | null;
  id?: string;
}

export function createWorkspace(
  state: WorkspaceState,
  options: CreateWorkspaceOptions,
): { state: WorkspaceState; workspace: StoredWorkspace } {
  const now = options.now ?? new Date();
  const name = cleanName(options.name);
  const clash = state.workspaces.some(
    (workspace) => workspace.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new WorkspaceError("a workspace with that name already exists");

  const workspace: StoredWorkspace = {
    id: options.id ?? uuidv7(now.getTime()),
    name,
    icon: options.icon ?? null,
    ownerId: options.ownerId,
    createdAt: now.toISOString(),
  };

  return {
    workspace,
    state: {
      ...state,
      workspaces: [...state.workspaces, workspace],
      members: [
        ...state.members,
        { workspaceId: workspace.id, userId: options.ownerId, role: "owner", joinedAt: now.toISOString() },
      ],
      // A workspace you just made is the one you want to look at.
      activeWorkspaceId: workspace.id,
    },
  };
}

export function renameWorkspace(
  state: WorkspaceState,
  workspaceId: string,
  name: string,
): WorkspaceState {
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  if (workspace === undefined) throw new WorkspaceError("that workspace no longer exists");
  const cleaned = cleanName(name);
  if (cleaned === workspace.name) return state;
  if (
    state.workspaces.some(
      (entry) =>
        entry.id !== workspaceId && entry.name.toLowerCase() === cleaned.toLowerCase(),
    )
  ) {
    throw new WorkspaceError("a workspace with that name already exists");
  }
  return {
    ...state,
    workspaces: state.workspaces.map((entry) =>
      entry.id === workspaceId ? { ...entry, name: cleaned } : entry,
    ),
  };
}

export function setActiveWorkspace(state: WorkspaceState, workspaceId: string): WorkspaceState {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new WorkspaceError("that workspace no longer exists");
  }
  if (state.activeWorkspaceId === workspaceId) return state;
  return { ...state, activeWorkspaceId: workspaceId };
}

export function addMember(
  state: WorkspaceState,
  options: { workspaceId: string; userId: string; role: Role; now?: Date },
): WorkspaceState {
  const workspace = state.workspaces.find((entry) => entry.id === options.workspaceId);
  if (workspace === undefined) throw new WorkspaceError("that workspace no longer exists");
  if (membershipOf(state, options.workspaceId, options.userId) !== null) return state;
  const now = options.now ?? new Date();
  return {
    ...state,
    members: [
      ...state.members,
      {
        workspaceId: options.workspaceId,
        userId: options.userId,
        role: options.role,
        joinedAt: now.toISOString(),
      },
    ],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Users and the unlocked local owner
 * ---------------------------------------------------------------------------------------------- */

export interface CreateUserOptions {
  email: string;
  name?: string;
  password?: string | null;
  now?: Date;
  id?: string;
}

export function createUser(
  state: WorkspaceState,
  options: CreateUserOptions,
): { state: WorkspaceState; user: StoredUser } {
  const problem = emailProblem(options.email);
  if (problem !== null) throw new WorkspaceError(problem);

  const email = normaliseEmail(options.email);
  if (state.users.some((user) => user.email === email)) {
    throw new WorkspaceError("an account with that email already exists");
  }

  const password = options.password ?? null;
  if (password !== null) {
    const passwordIssue = passwordProblem(password);
    if (passwordIssue !== null) throw new WorkspaceError(passwordIssue);
  }

  const now = options.now ?? new Date();
  const name = (options.name ?? "").trim();
  const user: StoredUser = {
    id: options.id ?? uuidv7(now.getTime()),
    email,
    name: name === "" ? email : name,
    passwordHash: password === null ? null : hashPassword(password),
    createdAt: now.toISOString(),
    lastSeenAt: null,
  };

  return {
    user,
    state: { ...state, users: [...state.users, user] },
  };
}

/** True once any account has a password: from then on every request needs a session. */
export function passwordRequired(state: WorkspaceState): boolean {
  return state.users.some((user) => user.passwordHash !== null);
}

export type SetPasswordResult =
  | { ok: true; state: WorkspaceState }
  | { ok: false; error: string };

/** Set a password, or pass null to unlock the machine again. */
export function setPassword(
  state: WorkspaceState,
  userId: string,
  password: string | null,
): SetPasswordResult {
  if (!state.users.some((user) => user.id === userId)) {
    return { ok: false, error: "that account no longer exists" };
  }
  if (password !== null) {
    const problem = passwordProblem(password);
    if (problem !== null) return { ok: false, error: problem };
  }
  return {
    ok: true,
    state: {
      ...state,
      users: state.users.map((user) =>
        user.id === userId
          ? { ...user, passwordHash: password === null ? null : hashPassword(password) }
          : user,
      ),
    },
  };
}

export function findUserByEmail(state: WorkspaceState, email: string): StoredUser | null {
  const normalised = normaliseEmail(email);
  return state.users.find((user) => user.email === normalised) ?? null;
}

export interface LocalSetup {
  state: WorkspaceState;
  user: StoredUser;
  workspace: StoredWorkspace;
  /** True when the file was missing a user, workspace or membership and now has it. */
  created: boolean;
}

/**
 * The machine's default owner and workspace, created once and then found again.
 *
 * This runs on the first request, so a fresh install opens straight into a usable app instead of a
 * sign-up form that a single-user localhost tool does not need.
 */
export function ensureLocalSetup(state: WorkspaceState, now: Date = new Date()): LocalSetup {
  let next = state;
  let created = false;

  let user = next.users.find((entry) => entry.email === LOCAL_OWNER_EMAIL) ?? null;
  if (user === null) {
    const result = createUser(next, {
      email: LOCAL_OWNER_EMAIL,
      name: LOCAL_OWNER_NAME,
      now,
    });
    next = result.state;
    user = result.user;
    created = true;
  }

  let workspace =
    next.workspaces.find((entry) => entry.id === next.activeWorkspaceId) ??
    next.workspaces[0] ??
    null;

  if (workspace === null) {
    const result = createWorkspace(next, { name: DEFAULT_WORKSPACE_NAME, ownerId: user.id, now });
    next = result.state;
    workspace = result.workspace;
    created = true;
  } else if (next.activeWorkspaceId !== workspace.id) {
    next = { ...next, activeWorkspaceId: workspace.id };
    created = true;
  }

  if (membershipOf(next, workspace.id, user.id) === null) {
    next = addMember(next, { workspaceId: workspace.id, userId: user.id, role: "owner", now });
    created = true;
  }

  return { state: next, user, workspace, created };
}

/* ------------------------------------------------------------------------------------------------
 * Sessions
 * ---------------------------------------------------------------------------------------------- */

export interface StartSessionOptions {
  userId: string;
  now?: Date;
  ttlMs?: number;
  userAgent?: string | null;
  ip?: string | null;
  /** Only the tests pass a token; normally one is generated. */
  token?: string;
}

export function startSession(
  state: WorkspaceState,
  options: StartSessionOptions,
): { state: WorkspaceState; session: StoredSession; token: string } {
  if (!state.users.some((user) => user.id === options.userId)) {
    throw new WorkspaceError("that account no longer exists");
  }
  const now = options.now ?? new Date();
  const issued = options.token === undefined
    ? newSessionToken()
    : { token: options.token, tokenHash: hashToken(options.token) };

  const session: StoredSession = {
    id: uuidv7(now.getTime()),
    userId: options.userId,
    tokenHash: issued.tokenHash,
    userAgent: options.userAgent ?? null,
    ip: options.ip ?? null,
    createdAt: now.toISOString(),
    expiresAt: sessionExpiresAt(now, options.ttlMs),
  };

  const live = state.sessions.filter((entry) => !sessionExpired(entry.expiresAt, now));
  return {
    token: issued.token,
    session,
    state: { ...state, sessions: [...live, session] },
  };
}

export function findSession(
  state: WorkspaceState,
  token: string,
  now: Date = new Date(),
): StoredSession | null {
  if (token === "") return null;
  const wanted = hashToken(token);
  return (
    state.sessions.find(
      (session) => session.tokenHash === wanted && !sessionExpired(session.expiresAt, now),
    ) ?? null
  );
}

export function pruneSessions(
  state: WorkspaceState,
  now: Date = new Date(),
): { state: WorkspaceState; removed: number } {
  const live = state.sessions.filter((session) => !sessionExpired(session.expiresAt, now));
  if (live.length === state.sessions.length) return { state, removed: 0 };
  return { state: { ...state, sessions: live }, removed: state.sessions.length - live.length };
}

export function endSession(state: WorkspaceState, token: string): WorkspaceState {
  if (token === "") return state;
  const wanted = hashToken(token);
  const sessions = state.sessions.filter((session) => session.tokenHash !== wanted);
  if (sessions.length === state.sessions.length) return state;
  return { ...state, sessions };
}

export type SignInResult =
  | { ok: true; state: WorkspaceState; user: StoredUser; token: string; session: StoredSession }
  | { ok: false; error: string };

export function signIn(
  state: WorkspaceState,
  input: { email: string; password: string; now?: Date; userAgent?: string | null; ip?: string | null },
): SignInResult {
  const user = findUserByEmail(state, input.email);
  if (user === null) return { ok: false, error: "no account with that email" };
  if (user.passwordHash === null) return { ok: false, error: "that account has no password" };
  if (!verifyPassword(input.password, user.passwordHash)) {
    return { ok: false, error: "wrong password" };
  }

  const started = startSession(state, {
    userId: user.id,
    now: input.now,
    userAgent: input.userAgent,
    ip: input.ip,
  });
  const seenAt = (input.now ?? new Date()).toISOString();
  return {
    ok: true,
    state: {
      ...started.state,
      users: started.state.users.map((entry) =>
        entry.id === user.id ? { ...entry, lastSeenAt: seenAt } : entry,
      ),
    },
    user: { ...user, lastSeenAt: seenAt },
    token: started.token,
    session: started.session,
  };
}

/**
 * Who the request is, or null when the machine is locked and the request carries no live session.
 * With no password anywhere, the local owner is trusted — a single-user tool on localhost does not
 * ask for a login it cannot tell apart from itself.
 */
export function identify(
  state: WorkspaceState,
  token: string | null,
  now: Date = new Date(),
): Identity | null {
  if (token !== null && token !== "") {
    const session = findSession(state, token, now);
    if (session !== null) {
      const user = state.users.find((entry) => entry.id === session.userId);
      if (user !== undefined) return identityFor(state, user, session);
    }
  }

  if (passwordRequired(state)) return null;

  const user = state.users.find((entry) => entry.email === LOCAL_OWNER_EMAIL) ?? state.users[0] ?? null;
  if (user === null) return null;
  return identityFor(state, user, null);
}

function identityFor(
  state: WorkspaceState,
  user: StoredUser,
  session: StoredSession | null,
): Identity {
  const workspace =
    activeWorkspace(state) ??
    (workspacesFor(state, user.id)[0] ?? null);
  const role = workspace === null ? null : (membershipOf(state, workspace.id, user.id)?.role ?? null);
  return { user, workspace, role, session };
}
