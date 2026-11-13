import { NextResponse } from "next/server";

import {
  LOCAL_OWNER_EMAIL,
  endSession,
  passwordRequired,
  setPassword,
  signIn,
  startSession,
  type Identity,
  type WorkspaceState,
} from "@slate/shared";

import {
  clearSessionCookie,
  loadStudio,
  requestIp,
  saveStudio,
  setSessionCookie,
} from "@/lib/session";

export const dynamic = "force-dynamic";

function summary(state: WorkspaceState, identity: Identity | null) {
  return {
    ok: true,
    locked: passwordRequired(state),
    signedIn: identity !== null && identity.session !== null,
    user: identity === null ? null : { email: identity.user.email, name: identity.user.name },
    workspace: identity?.workspace ?? null,
    role: identity?.role ?? null,
  };
}

/** Who this request is, and whether a password stands between the app and the files. */
export async function GET() {
  const { state, identity } = await loadStudio();
  return NextResponse.json(summary(state, identity));
}

/** Sign in with the local account's password. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof payload.email === "string" && payload.email !== ""
    ? payload.email
    : LOCAL_OWNER_EMAIL;
  const password = typeof payload.password === "string" ? payload.password : "";

  const { state } = await loadStudio();
  const result = signIn(state, {
    email,
    password,
    userAgent: request.headers.get("user-agent"),
    ip: requestIp(request),
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }

  saveStudio(result.state);
  await setSessionCookie(result.token);
  return NextResponse.json({ ok: true, user: { email: result.user.email, name: result.user.name } });
}

type PasswordResult = ReturnType<typeof setPassword>;

/**
 * Set or clear the local password.
 *
 * Setting one keeps the current browser signed in, so protecting the machine does not lock the
 * person who just did it out of the page they are on.
 */
export async function PATCH(request: Request) {
  const { state, identity } = await loadStudio();
  if (identity === null) {
    return NextResponse.json({ ok: false, error: "sign in first" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const payload = (body ?? {}) as { password?: unknown };
  if (payload.password === undefined) {
    return NextResponse.json({ ok: false, error: "a password is required" }, { status: 400 });
  }
  if (payload.password !== null && typeof payload.password !== "string") {
    return NextResponse.json({ ok: false, error: "a password must be text" }, { status: 400 });
  }

  const password = payload.password === null || payload.password === "" ? null : payload.password;
  const result: PasswordResult = setPassword(state, identity.user.id, password);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  let next = result.state;
  if (password !== null && identity.session === null) {
    const started = startSession(next, { userId: identity.user.id });
    next = started.state;
    await setSessionCookie(started.token);
  }
  saveStudio(next);

  return NextResponse.json({ ok: true, locked: passwordRequired(next) });
}

/** Sign out: drop the session on both ends. */
export async function DELETE() {
  const { state, token } = await loadStudio();
  if (token !== null) saveStudio(endSession(state, token));
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
