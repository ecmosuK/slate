"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The only screen without a sidebar: the machine has a password and this browser does not have a
 * session. Signing in sets the cookie and asks the server for the page again.
 */
export default function Lock() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!body.ok) throw new Error(body.error ?? "that password did not work");
      setPassword("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <main className="lock-screen">
      <form className="card lock-card" onSubmit={submit}>
        <h1>Slate is locked</h1>
        <p className="subtitle">Enter the local password to open your projects.</p>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy || password === ""}>
            {busy ? "Opening…" : "Unlock"}
          </button>
        </div>
        {error !== null && <p className="notice bad">{error}</p>}
      </form>
    </main>
  );
}
