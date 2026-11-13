/**
 * The request's identity, resolved once per page or route.
 *
 * The shared package owns the rules; this file is the thin Next.js edge of them: read the cookie,
 * bootstrap the local owner on a fresh install, hand back an `Identity` or null when the machine is
 * locked. Only route handlers may set or clear the cookie — server components can only read it.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  SESSION_TTL_MS,
  ensureLocalSetup,
  identify,
  passwordRequired,
  pruneSessions,
  readWorkspaceState,
  writeWorkspaceState,
  type Identity,
  type WorkspaceState,
} from "@slate/shared";

export const SESSION_COOKIE = "slate_session";

export interface Studio {
  state: WorkspaceState;
  identity: Identity | null;
  token: string | null;
  /** True while any account has a password, so the UI can offer to remove it. */
  locked: boolean;
}

export async function loadStudio(): Promise<Studio> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  const now = new Date();

  let state = readWorkspaceState();
  const setup = ensureLocalSetup(state, now);
  state = setup.state;

  const pruned = pruneSessions(state, now);
  state = pruned.state;

  if (setup.created || pruned.removed > 0) writeWorkspaceState(state);

  return {
    state,
    identity: identify(state, token, now),
    token,
    locked: passwordRequired(state),
  };
}

export function saveStudio(state: WorkspaceState): void {
  writeWorkspaceState(state);
}

/** Null when the request may write; otherwise the response to send instead. */
export async function guardWrite(): Promise<NextResponse | null> {
  const { identity } = await loadStudio();
  if (identity !== null) return null;
  return NextResponse.json(
    { ok: false, error: "sign in to change anything" },
    { status: 401 },
  );
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export function requestIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded !== "") return forwarded.split(",")[0]?.trim() ?? null;
  return null;
}
