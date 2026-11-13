"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DEFAULT_CHAT_MODEL } from "@/lib/model-defaults";

interface Model {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  source?: "openrouter" | "opencode" | "gemini";
  tools?: boolean | null;
  unavailableUntil?: number | null;
  unavailableReason?: string | null;
}

interface Settings {
  hasKey: boolean;
  maskedKey: string | null;
  hasGeminiKey?: boolean;
  maskedGeminiKey?: string | null;
  defaultModel: string | null;
  caps: Record<string, number | null>;
  configPath: string;
  projectsRoot: string | null;
}

interface SessionInfo {
  ok: boolean;
  locked: boolean;
  signedIn: boolean;
  user: { email: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  role: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

function price(entry: Model): string {
  if (entry.promptPrice === 0 || entry.id.endsWith(":free") || entry.id === "openrouter/free") {
    return "free";
  }
  if (entry.promptPrice === null) return "";
  const perMillion = entry.promptPrice * 1_000_000;
  if (perMillion < 0.01) return "$0";
  return `$${perMillion.toFixed(perMillion < 1 ? 3 : 2)}/M`;
}

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [model, setModel] = useState("");
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [capModel, setCapModel] = useState("");
  const [capAmount, setCapAmount] = useState("");
  const [allJobs, setAllJobs] = useState<{ model: string | null; costMicros: number }[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [configResponse, modelsResponse, sessionResponse, workspacesResponse] =
        await Promise.all([
          fetch("/api/config"),
          fetch("/api/models"),
          fetch("/api/session"),
          fetch("/api/workspaces"),
        ]);
      const config = (await configResponse.json()) as Settings;
      setSettings(config);
      setModel(
        config.defaultModel !== null && config.defaultModel !== ""
          ? config.defaultModel
          : DEFAULT_CHAT_MODEL,
      );

      const nextCaps: Record<string, string> = {};
      for (const [modelId, cap] of Object.entries(config.caps ?? {})) {
        nextCaps[modelId] = cap === null ? "" : String(cap);
      }
      setCaps(nextCaps);

      const catalogue = (await modelsResponse.json()) as { ok: boolean; models?: Model[] };
      if (catalogue.ok) setModels(catalogue.models ?? []);

      const jobsResponse = await fetch("/api/jobs", { cache: "no-store" });
      const jobsBody = (await jobsResponse.json()) as {
        ok: boolean;
        jobs?: { model: string | null; costMicros: number }[];
      };
      if (jobsBody.ok) setAllJobs(jobsBody.jobs ?? []);

      const identity = (await sessionResponse.json()) as SessionInfo;
      setSession(identity);
      setWorkspaceName(identity.workspace?.name ?? "");

      const list = (await workspacesResponse.json()) as {
        ok: boolean;
        workspaces?: WorkspaceRow[];
      };
      if (list.ok) setWorkspaces(list.workspaces ?? []);
    })();
  }, []);

  async function call(
    url: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const nextCaps: Record<string, number | null> = {};
      for (const [modelId, amount] of Object.entries(caps)) {
        const parsed = Number.parseFloat(amount);
        nextCaps[modelId] = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      }
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, geminiApiKey, defaultModel: model, caps: nextCaps }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!body.ok) throw new Error(body.error ?? "the settings could not be saved");
      setApiKey("");
      setGeminiApiKey("");
      const refreshed = (await (await fetch("/api/config")).json()) as Settings;
      setSettings(refreshed);
      const catalogue = (await (await fetch("/api/models")).json()) as { ok: boolean; models?: Model[] };
      if (catalogue.ok) setModels(catalogue.models ?? []);
      setNotice("saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = (await response.json()) as { ok: boolean; reply?: string; error?: string };
      if (!body.ok) throw new Error(body.error ?? "the model did not answer");
      setNotice(`reply: ${body.reply ?? ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function renameWorkspace() {
    if (session?.workspace == null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await call("/api/workspaces", "PATCH", {
        id: session.workspace.id,
        name: workspaceName,
      });
      if (body["ok"] !== true) {
        throw new Error(String(body["error"] ?? "the workspace could not be renamed"));
      }
      setSession({ ...session, workspace: { ...session.workspace, name: workspaceName.trim() } });
      setNotice("workspace renamed");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function savePassword() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await call("/api/session", "PATCH", { password });
      if (body["ok"] !== true) {
        throw new Error(String(body["error"] ?? "the password could not be saved"));
      }
      setPassword("");
      setSession(session === null ? null : { ...session, locked: true, signedIn: true });
      setNotice("password saved — this browser stays signed in");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removePassword() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await call("/api/session", "PATCH", { password: null });
      if (body["ok"] !== true) {
        throw new Error(String(body["error"] ?? "the password could not be removed"));
      }
      setSession(session === null ? null : { ...session, locked: false });
      setNotice("password removed: this machine opens again without a login");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await fetch("/api/session", { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <main>
      <h1>Settings</h1>
      <p className="subtitle">
        Add keys for the providers you want to use. Slate shows only free models (OpenRouter, Gemini,
        and opencode) and automatically switches to the next free model when one is rate-limited or fails.
        Keys stay on this machine.
      </p>

      {notice !== null && <p className="notice ok">{notice}</p>}
      {error !== null && <p className="notice bad">{error}</p>}

      <section className="card">
        <h2>API keys</h2>
        <div className="meta">
          {settings?.hasKey === true ? (
            <span className="chip accent">OpenRouter · {settings.maskedKey}</span>
          ) : (
            <span className="chip warn">no OpenRouter key</span>
          )}
          {settings?.hasGeminiKey === true ? (
            <span className="chip accent">Gemini · {settings.maskedGeminiKey}</span>
          ) : (
            <span className="chip">no Gemini key</span>
          )}
          {settings?.defaultModel !== null && settings?.defaultModel !== undefined && settings.defaultModel !== "" && (
            <span className="chip">{settings.defaultModel}</span>
          )}
        </div>

        <label className="field">
          <span>OpenRouter API key</span>
          <input
            type="password"
            value={apiKey}
            placeholder={settings?.maskedKey ?? "sk-or-v1-…"}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span>Gemini API key</span>
          <input
            type="password"
            value={geminiApiKey}
            placeholder={settings?.maskedGeminiKey ?? "AIza…"}
            onChange={(event) => setGeminiApiKey(event.target.value)}
            autoComplete="off"
          />
          <span className="meta">Used for Google Gemini models (free tier available). Leave blank to keep the saved key.</span>
        </label>

        <label className="field">
          <span>Default model</span>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">choose a model…</option>
            {models.map((entry) => {
              const unavailable =
                typeof entry.unavailableUntil === "number" && entry.unavailableUntil > Date.now();
              return (
                <option key={entry.id} value={entry.id} disabled={unavailable}>
                  {entry.source === "opencode" ? "[opencode] " : entry.source === "gemini" ? "[gemini] " : ""}
                  {entry.name} · {price(entry)}
                  {entry.tools === false ? " · no tools" : ""}
                  {unavailable ? " · free limit reached" : ""}
                </option>
              );
            })}
          </select>
        </label>

        <div className="row">
          <button onClick={save} disabled={busy}>
            Save
          </button>
          <button onClick={test} disabled={busy || model === ""}>
            Send a test message
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Model spend caps</h2>
        <p className="meta">
          Cap how much each model may spend, in US dollars. Once a model's recorded spend reaches
          its cap, new jobs on that model are refused until the cap is raised or removed. Leave a
          cap empty for no limit.
        </p>
        {Object.entries(caps).length === 0 && <p className="meta">No caps set yet.</p>}
        {Object.entries(caps).map(([modelId, amount]) => {
          const spent = allJobs.reduce(
            (total, job) => (job.model === modelId ? total + job.costMicros : total),
            0,
          ) / 1_000_000;
          const parsed = Number.parseFloat(amount);
          const atCap = Number.isFinite(parsed) && spent >= parsed;
          return (
            <div key={modelId} className="job-form-row">
              <label className="field">
                <span>{modelId}</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(event) => setCaps({ ...caps, [modelId]: event.target.value })}
                />
              </label>
              <span className="meta">
                spent ${spent.toFixed(4)}
                {atCap ? ` of $${parsed.toFixed(2)}` : ""}
              </span>
              {atCap && <span className="chip warn">at cap — jobs refused</span>}
              <button
                type="button"
                onClick={() => {
                  const next = { ...caps };
                  delete next[modelId];
                  setCaps(next);
                }}
              >
                Remove
              </button>
            </div>
          );
        })}
        <div className="job-form-row">
          <label className="field">
            <span>Model</span>
            <input
              value={capModel}
              onChange={(event) => setCapModel(event.target.value)}
              placeholder="e.g. openrouter/free"
            />
          </label>
          <label className="field">
            <span>Cap (USD)</span>
            <input
              type="number"
              min="0"
              step="any"
              value={capAmount}
              onChange={(event) => setCapAmount(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={capModel.trim() === ""}
            onClick={() => {
              const parsed = Number.parseFloat(capAmount);
              const next = { ...caps };
              next[capModel.trim()] =
                Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "";
              setCaps(next);
              setCapModel("");
              setCapAmount("");
            }}
          >
            Add
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Workspace</h2>
        <p className="meta">
          Projects, notes and tasks belong to the workspace on screen. Switch or add one from the
          sidebar.
        </p>
        <label className="field">
          <span>Workspace name</span>
          <input
            value={workspaceName}
            maxLength={60}
            disabled={session?.workspace == null}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
        </label>
        <div className="row">
          <button
            onClick={() => void renameWorkspace()}
            disabled={busy || session?.workspace == null || workspaceName.trim() === ""}
          >
            Rename
          </button>
        </div>
        <div className="meta">
          {workspaces.map((workspace) => (
            <span key={workspace.id} className={workspace.active ? "chip accent" : "chip"}>
              {workspace.name} · {workspace.role}
            </span>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Lock</h2>
        <p className="meta">
          This machine binds to 127.0.0.1. A password asks for a login before any project can be
          read or changed; it is stored as a scrypt hash beside the settings.
        </p>
        <div className="meta">
          <span>{session?.user?.email ?? "…"}</span>
          {session?.locked === true ? (
            <span className="chip accent">password set</span>
          ) : (
            <span className="chip warn">no password</span>
          )}
          <span className="chip">{session?.signedIn === true ? "signed in" : "local trust"}</span>
        </div>
        <label className="field">
          <span>{session?.locked === true ? "New password" : "Password"}</span>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder="at least 8 characters"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="row">
          <button onClick={() => void savePassword()} disabled={busy || password === ""}>
            {session?.locked === true ? "Change password" : "Protect this machine"}
          </button>
          {session?.locked === true && (
            <button onClick={() => void removePassword()} disabled={busy}>
              Remove password
            </button>
          )}
          {session?.signedIn === true && (
            <button onClick={() => void signOut()} disabled={busy}>
              Sign out
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Where things are</h2>
        <div className="meta">
          <span>
            settings: <code>{settings?.configPath ?? "…"}</code>
          </span>
        </div>
        <div className="meta">
          <span>
            projects root: <code>{settings?.projectsRoot ?? "the default"}</code>
          </span>
        </div>
      </section>
    </main>
  );
}
